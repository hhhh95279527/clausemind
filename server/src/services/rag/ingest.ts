// server/src/services/rag/ingest.ts
// 文档入库：上传 → 提取文本 → 分片 → 向量化 → 存入 PG（DocChunk.embedding JSON）
// 与旧版差异：移除 ChromaDB 外部依赖，检索层见 pg-store.ts；docType 区分法规/模板/普通库。
import fs from 'fs/promises'
import path from 'path'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import type { DocType } from '@prisma/client'
import { embeddings } from '../model.js'
import { logger } from '../../utils/logger.js'
import { DatabaseService } from '../../database/database.service.js'
import { embedTexts } from './pg-store.js'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { PDFDocument } from 'pdf-lib'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { ocrImageFile } from '../vision-ocr.js'

// 单次入库最多 300 个 chunk，防止 embedding API 调用过多
const MAX_CHUNKS = 300

// ── 数据库服务引用（由 KnowledgeController / ContractModule 注入）──
let db: DatabaseService | null = null

export function setDatabase(database: DatabaseService) {
  db = database
}

/** 检索层取库句柄用（query.ts / 工具函数不在 Nest 注入体系内） */
export function getRagDatabase(): DatabaseService | null {
  return db
}

// 解析硬上限：防压缩包/畸形 PDF 卡死事件循环（图片走视觉 OCR 可能耗时数十秒，120s），
// 提取文本最多 200 万字符（约 400 万字以内，防解压炸弹撑爆内存与 embedding 成本）。
const EXTRACT_TIMEOUT_MS = 120_000
const MAX_EXTRACT_CHARS = 2_000_000

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    // 不阻止进程退出
    timer.unref?.()
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// ── 文本提取（对外）：超时 + 长度硬上限包装 ─────────────────────
// callbacks 可选：图片 OCR 的 LLM Span 经此挂到当前 Trace（token/成本入账）
export async function extractText(
  filePath: string,
  callbacks?: BaseCallbackHandler[],
): Promise<{ text: string; metadata: any }> {
  const result = await withTimeout(
    extractTextUnsafe(filePath, callbacks),
    EXTRACT_TIMEOUT_MS,
    `文档解析超时（${EXTRACT_TIMEOUT_MS / 1000}s），请检查文件是否损坏或过大`,
  )
  if (result.text.length > MAX_EXTRACT_CHARS) {
    throw new Error(`文档内容过大（提取文本超过 ${MAX_EXTRACT_CHARS} 字符），请拆分后上传`)
  }
  return result
}

// ── 文本提取：根据文件类型读取内容（多格式 + 图片视觉 OCR）──────
async function extractTextUnsafe(
  filePath: string,
  callbacks?: BaseCallbackHandler[],
): Promise<{ text: string; metadata: any }> {
  const ext = path.extname(filePath).toLowerCase()
  let text = ''
  const meta: any = { fileType: ext, hasImages: false, hasTables: false }

  try {
    // 1. 纯文本文件
    if (ext === '.txt' || ext === '.md') {
      text = await fs.readFile(filePath, 'utf-8')
      return { text, metadata: meta }
    }

    // 2. Word (.docx)
    if (ext === '.docx') {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.extractRawText({ buffer })
      text = result.value
      if (text.includes('\t') || /\|.*\|/.test(text)) {
        meta.hasTables = true
      }
      return { text, metadata: meta }
    }

    // 3. Excel (.xlsx/.xls)
    if (ext === '.xlsx' || ext === '.xls') {
      const buffer = await fs.readFile(filePath)
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sheets: string[] = []

      workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName]
        const csv = XLSX.utils.sheet_to_csv(sheet)
        sheets.push(`## ${sheetName}\n${csv}`)
      })

      text = sheets.join('\n\n---\n\n')
      meta.hasTables = true
      return { text, metadata: meta }
    }

    // 4. PDF 文件
    if (ext === '.pdf') {
      const buffer = await fs.readFile(filePath)

      let extractedText = ''
      let pageCount = 0

      try {
        const { PDFParse } = await import('pdf-parse')
        const parser = new PDFParse({ data: buffer })
        // @ts-ignore - pdf-parse v5 API 不稳定
        const result = await parser.parse()
        extractedText = result.text || ''
        pageCount = result.pages?.length || 1
      } catch (e) {
        logger.warn('pdf-parse v5 failed, trying fallback', { error: (e as Error).message })
        try {
          const pdfParseModule = await import('pdf-parse')
          // @ts-ignore - 动态导入类型不确定
          const pdfParse: any = pdfParseModule.default || pdfParseModule
          if (typeof pdfParse === 'function') {
            const result = await pdfParse(buffer)
            extractedText = result.text
            pageCount = result.numpages || 1
          }
        } catch (e2) {
          throw new Error(`PDF 解析失败: ${(e2 as Error).message}`)
        }
      }

      // 检测是否为扫描版（文字密度低）
      const avgCharsPerPage = extractedText.length / Math.max(pageCount, 1)
      const isScanned = avgCharsPerPage < 50

      if (isScanned && extractedText.trim().length < 100) {
        logger.info('PDF detected as scanned, OCR not fully supported', { avgCharsPerPage })
        text = `[此 PDF 为扫描版（共 ${pageCount} 页），当前版本仅支持原生文字 PDF，请转换后上传]`
        meta.hasImages = true
      } else {
        text = extractedText
      }

      meta.pageCount = pageCount
      return { text, metadata: meta }
    }

    // 5. 图片合同（jpg/png）：deepseek-flash 视觉 OCR 转录，下游切条款/双轨审查不变
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
      text = await ocrImageFile(filePath, ext, callbacks)
      meta.hasImages = true
      meta.ocr = true
      return { text, metadata: meta }
    }

    // 6. PPTX：zip 结构，暂不支持完整解析
    if (ext === '.pptx') {
      text = '[PPTX 文件暂不支持完整解析，请转换为 PDF 后上传]'
      return { text, metadata: meta }
    }

    // 7. 兜底：当作文本读取
    text = await fs.readFile(filePath, 'utf-8')
    return { text, metadata: meta }
  } catch (err) {
    logger.error('extractText failed', { filePath, error: (err as Error).message })
    throw new Error(`文档解析失败 (${ext}): ${(err as Error).message}`)
  }
}

export interface IngestInput {
  filePath: string
  fileName: string
  title?: string
  category?: string
  docType?: DocType
  tenantId?: string | null
  uploadedBy?: string | null
  /** 法规问答会话隔离：GENERAL 文档归属的会话 ID（LEGAL/TEMPLATE 平台库不传） */
  sessionId?: string | null
  /** 指定文档 ID（种子数据幂等用）；不传则自动生成 */
  docId?: string
  /** 入库后是否删除临时文件，默认删除 */
  keepFile?: boolean
}

// ── 核心：文档入库（文件 → PG）─────────────────────────────────
export async function ingestDocument(input: IngestInput) {
  const { filePath, fileName } = input
  const title = input.title || fileName.replace(/\.[^.]+$/, '')
  const category = input.category || '通用'
  const docType: DocType = input.docType || 'GENERAL'
  const docId = input.docId || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  logger.info('rag: ingesting document', { docId, title, docType })

  if (!db) throw new Error('数据库未初始化，无法入库')

  // 幂等：种子重跑时先清旧数据
  const existing = await db.document.findUnique({ where: { id: docId } })
  if (existing) {
    await db.docChunk.deleteMany({ where: { documentId: docId } })
    await db.document.delete({ where: { id: docId } })
  }

  // 1. 提取文本
  const { text: rawText, metadata: docMetadata } = await extractText(filePath)
  if (!rawText.trim()) throw new Error('文档内容为空，无法处理')

  // 2. 文档分片
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 80,
    separators: ['\n\n\n', '\n\n', '\n', '。', '；', '，', ' ', ''],
  })
  const textChunks = (await splitter.splitText(rawText)).slice(0, MAX_CHUNKS)
  logger.info('rag: document split', { docId, chunks: textChunks.length })

  // 3. 向量化（无 key 时得到空数组，检索层自动走关键词模式）
  const vectors = await embedTexts(textChunks).catch((e) => {
    logger.warn('rag: embedding failed, store empty vectors', { error: e.message })
    return textChunks.map(() => [])
  })

  // 4. Document + DocChunk 落库
  await db.document.create({
    data: {
      id: docId,
      title,
      fileName,
      docType,
      category,
      chunkCount: textChunks.length,
      charCount: rawText.length,
      preview: rawText.slice(0, 500).replace(/\s+/g, ' '),
      tenantId: input.tenantId ?? null,
      uploadedBy: input.uploadedBy ?? null,
      sessionId: input.sessionId ?? null,
    },
  })
  await db.docChunk.createMany({
    data: textChunks.map((content, i) => ({
      id: `chk_${docId}_${i}`,
      documentId: docId,
      chunkIndex: i,
      content,
      embedding: vectors[i] as any,
      metadata: { ...docMetadata, chunkIndex: i } as any,
    })),
  })

  // 5. 清理临时文件
  if (!input.keepFile) await fs.unlink(filePath).catch(() => {})

  logger.info('rag: ingest complete', { docId, chunks: textChunks.length, vectorized: vectors[0]?.length > 0 })
  return {
    id: docId,
    title,
    fileName,
    category,
    docType,
    chunks: textChunks.length,
    chars: rawText.length,
    uploadedAt: new Date().toISOString(),
    preview: rawText.slice(0, 120).replace(/\s+/g, ' ') + '...',
  }
}

/** 纯文本直接入库（种子法规库/模板库用，无需临时文件） */
export async function ingestText(input: Omit<IngestInput, 'filePath' | 'fileName'> & { content: string; fileName?: string }) {
  await fs.mkdir('./uploads', { recursive: true })
  const tmpPath = `./uploads/tmp_ingest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
  await fs.writeFile(tmpPath, input.content, 'utf-8')
  return ingestDocument({
    ...input,
    filePath: tmpPath,
    fileName: input.fileName || `${input.title || '文本'}.txt`,
  })
}

// ── 文档注册表（按租户/类型过滤）──────────────────────────────
// scope:
//   'mine'      仅本租户上传的 GENERAL 文档（严格 tenantId 相等，不含平台共享）
//   'platform'  仅平台共享的 LEGAL 法规库（tenantId=null）
//   undefined   旧行为：本租户 + 全部平台共享（LEGAL/TEMPLATE），仅非问答页调用方使用
export async function getDocRegistry(
  filter: { tenantId?: string | null; docType?: DocType; scope?: 'mine' | 'platform'; sessionId?: string | null } = {},
) {
  if (!db) return []
  let where: any = {}
  if (filter.scope === 'mine') {
    // 会话级隔离：我的文档只返回当前会话上传的 GENERAL 文档；
    // 未指定会话时给一个永不匹配的值（而不是退回租户全量，防止跨会话泄漏）
    where = {
      docType: 'GENERAL',
      tenantId: filter.tenantId ?? '__none__',
      sessionId: filter.sessionId || '__none__',
    }
  } else if (filter.scope === 'platform') {
    where = { docType: 'LEGAL', tenantId: null }
  } else {
    where = {
      ...(filter.docType ? { docType: filter.docType } : {}),
      // 法规/模板为平台共享；普通库只看本租户 + 共享文档
      ...(filter.tenantId
        ? { OR: [{ tenantId: filter.tenantId }, { tenantId: null }] }
        : {}),
    }
  }
  const docs = await db.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    fileName: d.fileName,
    docType: d.docType,
    category: d.category,
    chunks: d.chunkCount,
    chars: d.charCount,
    uploadedAt: d.createdAt.toISOString(),
    preview: d.preview,
  }))
}

// ── 删除文档（PG 文档 + chunks 级联；禁止删别租户/平台共享文档）──
export async function deleteDocument(docId: string, tenantId?: string) {
  if (!db) throw new Error('数据库未初始化')
  const doc = await db.document.findUnique({ where: { id: docId } })
  if (!doc) throw new Error('文档不存在')
  if (tenantId && doc.tenantId !== tenantId) throw new Error('无权删除该文档')
  await db.docChunk.deleteMany({ where: { documentId: docId } })
  await db.document.delete({ where: { id: docId } })
  logger.info('rag: document deleted', { docId })
}

// embeddings 是否可用（控制器决定提示文案）
export function hasEmbeddings() {
  return !!embeddings
}
