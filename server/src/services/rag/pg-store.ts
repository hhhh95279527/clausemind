// server/src/services/rag/pg-store.ts
// PG 向量检索层：demo 规模下 embedding 以 JSON 存 PG、应用层算余弦；
// 未配置 embedding key 时降级为中文关键词召回（标点切词 + 词长加权），功能不中断。
// 规模增长后只需把本文件替换为 pgvector 的 <=> 检索，调用方零改动。
import type { DocType, PrismaClient } from '@prisma/client'
import { embeddings } from '../model.js'
import { recordRetrieverSpan } from '../../observability/langchain-observer.js'
import { logger } from '../../utils/logger.js'

export interface RetrieveOptions {
  k?: number
  /** 文档类型过滤：LEGAL 法规库 / TEMPLATE 模板库 / GENERAL 租户知识库 */
  docType?: DocType
  /** 租户隔离：GENERAL 文档限定本租户；LEGAL/TEMPLATE 为平台共享（tenantId=null） */
  tenantId?: string | null
  /** 旧接口兼容：按 category 文本过滤 */
  category?: string
  /**
   * 仅检索本租户私有文档（严格 tenantId 相等，不混入 tenantId=null 的平台共享文档）。
   * 法规问答页"我的文档"范围使用；默认 false 保持旧调用方行为不变。
   */
  ownOnly?: boolean
  /** 会话级隔离：仅检索该会话上传的文档；须与 ownOnly 同时使用 */
  sessionId?: string | null
}

export interface RetrievedChunk {
  chunkId: string
  docId: string
  title: string
  content: string
  score: number
  mode: 'vector' | 'keyword'
  category: string
  preview: string
}

const SIMILARITY_THRESHOLD = 0.35

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/**
 * 轻量中文分词（无外部分词器依赖）：
 * - 先按标点/空白/数字切片段；
 * - 拉丁片段整体小写保留；
 * - 中日韩片段生成 2~4 字滑动 n-gram（法律术语多为 3~4 字：试用期/经济补偿/竞业限制…）；
 * - 剔除停用字覆盖率过高的噪声 gram，长 gram 优先，总量封顶。
 */
const CJK_RE = /[一-鿿]/
const STOP_CHARS = new Set(
  '的了是在我你他她它们和与及或者而但也都就很还不没要会能可这个那上下为对把被让给等之以于由',
)
const SPLIT_RE = /[\s，。、？?！!,.；;：:"“”'‘’（）()【】\[\]《》<>\/\\|\-—_~`@#$%^&*+=0-9]+/

function stopRatio(gram: string): number {
  let n = 0
  for (const ch of gram) if (STOP_CHARS.has(ch)) n++
  return n / gram.length
}

export function tokenize(text: string): string[] {
  const grams34: string[] = []
  const grams2: string[] = []
  for (const rawSeg of text.split(SPLIT_RE)) {
    const seg = rawSeg.trim()
    if (!seg) continue
    if (!CJK_RE.test(seg)) {
      if (seg.length >= 2) grams34.push(seg.toLowerCase())
      continue
    }
    const chars = Array.from(seg)
    // 短中文片段（2 字）直接作为 bigram
    if (chars.length === 2) {
      if (stopRatio(seg) < 1) grams2.push(seg)
      continue
    }
    for (let n = 2; n <= Math.min(4, chars.length); n++) {
      for (let i = 0; i + n <= chars.length; i++) {
        const gram = chars.slice(i, i + n).join('')
        // 超过一半是停用字（如"可以的"）的 gram 没有区分度
        if (stopRatio(gram) > 0.5) continue
        if (n >= 3) grams34.push(gram)
        else grams2.push(gram)
      }
    }
  }
  const uniq = (arr: string[]) => Array.from(new Set(arr))
  // 长词元优先（更长的匹配更具区分度），总量控制 SQL OR 规模
  return [...uniq(grams34).sort((a, b) => b.length - a.length), ...uniq(grams2)].slice(0, 32)
}

/**
 * 从 PG 检索相关 chunk。
 * 向量模式：全表取候选（demo 数据量 < 10 万 chunk）应用层余弦；
 * 关键词模式：SQL contains OR 召回 + 命中词长加权精排。
 */
export async function retrieveFromPg(
  db: PrismaClient,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedChunk[]> {
  const started = Date.now()
  const k = opts.k ?? 4

  // 文档可见范围：
  // - LEGAL/TEMPLATE 为平台共享库，不按租户过滤；
  // - GENERAL/未指定类型必须限定可见性：本租户 + 平台共享；无租户身份时仅平台共享（默认拒绝，防跨租户泄漏）。
  const docWhere: any = {}
  if (opts.docType) docWhere.docType = opts.docType
  if (opts.category) docWhere.category = opts.category
  if (opts.ownOnly) {
    // 严格租户私有：只看本租户文档，绝不含平台共享（tenantId=null）
    docWhere.tenantId = opts.tenantId ?? '__none__'
    // 会话级隔离：只检索当前会话上传的文档；无会话上下文时永不命中
    docWhere.sessionId = opts.sessionId || '__none__'
  } else if (opts.docType !== 'LEGAL' && opts.docType !== 'TEMPLATE') {
    docWhere.OR = opts.tenantId
      ? [{ tenantId: opts.tenantId }, { tenantId: null }]
      : [{ tenantId: null }]
  }

  // ── 向量模式 ──────────────────────────────────────────────────
  if (embeddings) {
    try {
      const queryVec = await embeddings.embedQuery(query)
      const chunks = await db.docChunk.findMany({
        where: { document: docWhere },
        include: { document: true },
        take: 20000,
      })
      const scored = chunks
        .map((c) => {
          const vec = c.embedding as unknown as number[]
          return { c, score: Array.isArray(vec) && vec.length ? cosine(queryVec, vec) : 0 }
        })
        .filter((x) => x.score >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)

      if (scored.length) {
        const out = scored.map(({ c, score }) => toResult(c, score, 'vector'))
        await recordRetrieverSpan(
          'pg-vector-search',
          { query, mode: 'vector', k },
          { count: out.length, topScore: out[0].score, titles: out.map((o) => o.title) },
          Date.now() - started,
        )
        return out
      }
      // 向量没命中（空库/问题太偏）：继续走关键词兜底
    } catch (e) {
      logger.warn('pg-store: vector retrieve failed, fallback to keyword', { error: (e as Error).message })
    }
  }

  // ── 关键词模式（embedding 未配置 / 向量零命中时的兜底）────────────
  const tokens = tokenize(query)
  if (!tokens.length) return []

  const chunks = await db.docChunk.findMany({
    where: {
      document: docWhere,
      OR: tokens.map((t) => ({ content: { contains: t } })),
    },
    include: { document: true },
    take: 200,
  })

  const scored = chunks
    .map((c) => ({
      c,
      score: tokens.reduce((s, t) => s + (c.content.includes(t) ? t.length : 0), 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    // 归一化到 0~1 区间，仅用于前端展示（n-gram 命中按字数计分，12 字即近满分）
    .map((x) => ({ c: x.c, score: Math.min(0.92, 0.35 + x.score / 12) }))

  const out = scored.map(({ c, score }) => toResult(c, score, 'keyword'))
  await recordRetrieverSpan(
    'pg-keyword-search',
    { query, mode: 'keyword', k },
    { count: out.length, topScore: out[0]?.score },
    Date.now() - started,
  )
  return out
}

function toResult(c: any, score: number, mode: 'vector' | 'keyword'): RetrievedChunk {
  return {
    chunkId: c.id,
    docId: c.documentId,
    title: c.document?.title || '未知来源',
    content: c.content,
    score: parseFloat(score.toFixed(3)),
    mode,
    category: c.document?.category || '通用',
    preview: `${c.content.slice(0, 80).replace(/\s+/g, ' ')}...`,
  }
}

/** 向量化并持久化一批 chunk；无 embedding key 时存空数组（检索自动降级关键词） */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddings) return texts.map(() => [])
  return embeddings.embedDocuments(texts)
}
