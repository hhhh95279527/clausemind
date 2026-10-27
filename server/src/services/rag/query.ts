// server/src/services/rag/query.ts
// RAG 查询：PG 检索相关 chunk（向量优先、关键词兜底）+ 生成带来源标注的回答
// 全链路 callbacks 透传：查询扩展/压缩/回答的每次 LLM 调用都落 LLM Span，检索落 RETRIEVER Span。
import type { DocType } from '@prisma/client'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { chatModel } from '../model.js'
import { getRagDatabase } from './ingest.js'
import { retrieveFromPg, type RetrievedChunk } from './pg-store.js'
import { activeContext } from '../../observability/trace-context.js'
import { logger } from '../../utils/logger.js'

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

// ── 查询重写：结合 DB 历史理解当前问题（指代消解）────────────────
const REWRITE_PROMPT = `你是一个对话理解助手。请根据对话历史，理解用户的当前问题。
如果当前问题指代不明（如"这个文档"、"它"、"总结一下"等），请结合历史将其改写为完整、明确的问题。
只输出改写后的问题，不要解释。

对话历史：
{history}

当前问题：{question}

改写后的问题：`

async function rewriteWithHistory(
  question: string,
  history: HistoryTurn[],
  callbacks?: BaseCallbackHandler[],
): Promise<string> {
  const recent = history.slice(-6)
  if (!recent.length) return question
  const historyText = recent
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n')
  try {
    const prompt = ChatPromptTemplate.fromMessages([['system', REWRITE_PROMPT]])
    const result = await prompt.pipe(chatModel).pipe(new StringOutputParser())
      .invoke({ history: historyText, question }, { callbacks })
    return result.trim() || question
  } catch (e) {
    logger.warn('rag: query rewrite failed, using original', { error: (e as Error).message })
    return question
  }
}

const FINAL_K = 4          // 最终保留的文档数
const MULTI_QUERY_COUNT = 3 // 多查询扩展的变体数量

const QUERY_EXPANSION_PROMPT = `你是一个擅长法律与合同文书检索的助手。
给定用户的一个问题，请从 {count} 个不同角度做近义改写，使其更容易在法律条文库中检索到相关内容。
要求：
1. 必须保持原问题的主题与语境，不得引入原问题没有的新概念，不得变成泛泛的元问题
2. 使用法律/合同场景中的规范用词（如"工资"可改写为"劳动报酬"，"辞退"可改写为"解除劳动合同"）
3. 每个变体单独一行，以数字序号开头（如 1. 2. 3.），直接输出问题本身，不要解释`

function parseQueryVariants(text: string): string[] {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\./.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
}

/** 过滤退化变体：去掉标点后过短、纯疑问词、或长度异常的变体，避免跑偏的扩展稀释召回 */
function isValidVariant(v: string): boolean {
  const stripped = v.replace(/[\s\p{P}\p{S}0-9a-zA-Z]/gu, '')
  if (stripped.length < 3) return false
  // 纯元问题（"如何理解这个问题"之类）不含实质名词
  if (/如何理解|什么意思|怎么理解|这个问题|该问题|这句话/.test(v) && v.length < 15) return false
  if (v.length > 80) return false
  return true
}

async function expandQuery(question: string, callbacks?: BaseCallbackHandler[]): Promise<string[]> {
  try {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', QUERY_EXPANSION_PROMPT],
      ['human', '问题：{question}'],
    ])
    const result = await prompt.pipe(chatModel).pipe(new StringOutputParser())
      .invoke({ question, count: String(MULTI_QUERY_COUNT) }, { callbacks })
    const variants = parseQueryVariants(result)
      .filter((v) => v !== question && isValidVariant(v))
    const all = [question, ...variants]
    logger.info('rag: query expansion', { original: question, variants: all })
    return Array.from(new Set(all))
  } catch (e) {
    // 未配置模型 key 等情况：用原问题检索，功能不降级为报错
    logger.warn('rag: query expansion failed, using original', { error: (e as Error).message })
    return [question]
  }
}

interface RetrieveOptions {
  category?: string
  k?: number
  docType?: DocType
  tenantId?: string | null
  /** 仅检索本租户私有文档（不混入平台共享库） */
  ownOnly?: boolean
  /** 会话级隔离：仅检索该会话上传的文档 */
  sessionId?: string | null
}

// ── 检索：原始问题召回优先，扩展变体仅补位 ──────────────────────
// 经验：LLM 生成的扩展变体可能跑偏（元问题/语义漂移），若各变体平等竞争，
// 原始问题命中的高相关 chunk 会被挤出 top-k。因此：
// 1) 原始问题单独检索，其命中结果按分数直接占住名额；
// 2) 扩展变体并发召回，仅用于补满剩余名额（chunkId 去重，变体间取最高分）。
export async function retrieveDocs(question: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const db = getRagDatabase()
  if (!db) return []

  const k = opts.k ?? FINAL_K
  const tenantId = opts.tenantId ?? activeContext()?.tenantId ?? null
  const retrieve = (q: string) => retrieveFromPg(db as any, q, {
    k,
    docType: opts.docType,
    category: opts.category,
    tenantId,
    ownOnly: opts.ownOnly,
    sessionId: opts.sessionId,
  })
  // 原始问题优先检索：命中已满 k 条则直接返回，跳过查询扩展（省一次 LLM 调用，也避免变体跑偏）
  const originalDocs = (await retrieve(question)).sort((a, b) => b.score - a.score)
  const originalIds = new Set(originalDocs.map((d) => d.chunkId))
  if (originalDocs.length >= k) {
    logger.info('rag: retrieved docs (original only)', {
      question: question.slice(0, 40),
      relevant: originalDocs.length,
      topScore: originalDocs[0]?.score,
    })
    return originalDocs
  }

  // 原始问题召回不足：用扩展变体补满剩余名额（chunkId 去重，变体间取最高分）
  const queries = await expandQuery(question)
  const variantPool = new Map<string, RetrievedChunk>()
  const variants = queries.slice(1)
  if (variants.length) {
    const variantResults = await Promise.all(variants.map(retrieve))
    for (const docs of variantResults) {
      for (const d of docs) {
        if (originalIds.has(d.chunkId)) continue
        const exist = variantPool.get(d.chunkId)
        if (!exist || d.score > exist.score) variantPool.set(d.chunkId, d)
      }
    }
  }

  const top = [
    ...originalDocs,
    ...[...variantPool.values()].sort((a, b) => b.score - a.score),
  ].slice(0, k)

  logger.info('rag: retrieved docs', {
    question: question.slice(0, 40),
    queries: queries.length,
    originalHits: originalDocs.length,
    variantFills: top.length - originalDocs.length,
    relevant: top.length,
    topScore: top[0]?.score,
  })
  return top
}

// ── RAG Prompt ────────────────────────────────────────────────
// 防幻觉核心约束：回答必须逐句带条款级引用，数字必须与原文一致。
const RAG_SYSTEM = `你是 ClauseMind AI 知识库助手，是一个严谨的合同/法律问答系统。

## 核心规则（必须严格遵守）
1. **只根据下方提供的参考文档回答**，绝不使用文档之外的知识，不得推测或补全。
2. 如果参考文档中没有相关内容，明确回复"知识库中未找到相关内容"，不得编造。
3. **每个事实性陈述必须紧跟引用标注**，格式：[来源：文档名·第X条]（无条款号时用文档名）。
4. 对具体数据（金额、比例、期限、日期、名称）**必须与原文逐字一致**，不得四舍五入、换算或改写。
5. 若多个来源对同一问题有矛盾，分别列出各自说法并标注来源，不得自行取舍。
6. 回答末尾另起一行附【引用清单】，列出所有引用过的文档名与条款号。`

/**
 * 抽取式摘要：从原文中挑选与问题最相关的句子，**绝不改写原文**。
 * 旧版用 LLM 压缩（compressDoc）会改写原文引入幻觉，此处改为纯算法：
 * 按问题关键词命中度给句子打分，取 top-N 句，保留原文措辞。
 */
function extractRelevantSentences(content: string, question: string, maxSentences = 6): string {
  if (content.length < 300) return content
  const questionTokens = tokenizeForMatch(question)
  if (!questionTokens.length) return content.slice(0, 1200)

  // 按句号/分号/问号/感叹号切句（保留标点）
  const sentences = content.match(/[^。；;!?！？\n]+[。；;!?！？]?/g) || [content]
  const scored = sentences
    .map((s) => {
      const sTokens = tokenizeForMatch(s)
      const overlap = questionTokens.filter((t) => sTokens.includes(t)).length
      return { s: s.trim(), overlap }
    })
    .filter((x) => x.s.length > 0)
    .sort((a, b) => b.overlap - a.overlap)

  const top = scored.slice(0, maxSentences).map((x) => x.s)
  // 若命中句太少（<2），回退到原文截取（避免上下文丢失）
  const hitCount = scored.filter((x) => x.overlap > 0).length
  if (hitCount < 2) return content.slice(0, 1200)
  return top.join('')
}

/** 轻量匹配分词：中文 n-gram + 英文词，用于句子相关度打分（不依赖外部分词器） */
function tokenizeForMatch(text: string): string[] {
  const tokens = new Set<string>()
  for (const seg of text.split(/[\s，。、？?！!,.；;：:"'()（）\[\]【】]+/)) {
    if (!seg) continue
    if (/^[a-zA-Z0-9]+$/.test(seg)) {
      tokens.add(seg.toLowerCase())
    } else {
      // 中文 2~4 字 n-gram
      const chars = Array.from(seg)
      for (let n = 2; n <= Math.min(4, chars.length); n++) {
        for (let i = 0; i + n <= chars.length; i++) {
          tokens.add(chars.slice(i, i + n).join(''))
        }
      }
    }
  }
  return [...tokens]
}

/**
 * 数字校验：回答中的数字必须能在检索原文中找到对应，否则删除该数字并标注"原文未明确"。
 * 这是防幻觉的最后一道闸门——合同金额/比例/期限是最高风险点。
 */
function verifyNumbersInAnswer(answer: string, sourceContents: string[]): string {
  // 匹配数字（含小数点、千分位、百分号、金额单位）
  const numberPattern = /\d[\d,，.]*(?:％|%|万?元|万元|块|年|个月|月|日|天|小时)?/g
  const sourceText = sourceContents.join('\n')
  // 否定语境（"并非60000元""不是3个月"）中的数字是在纠正/排除，不应标记
  const NEGATION_BEFORE = /(?:不是|并非|非|没有|无|未|否|不等于)\s*$/

  return answer.replace(numberPattern, (match, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 8), offset)
    if (NEGATION_BEFORE.test(before)) return match
    // 去除千分位逗号和单位，提取纯数字核心
    const core = match.replace(/[,，]/g, '').match(/\d+(?:\.\d+)?/)
    if (!core) return match
    const numStr = core[0]
    // 在原文中查找该数字
    if (sourceText.includes(numStr)) return match
    // 数字在原文中找不到 → 标注存疑
    return `【原文未明确：${match}】`
  })
}

function buildContext(docs: RetrievedChunk[]): string {
  return docs.map((doc, i) => {
    const meta = doc.metadata
    const locator = meta?.clauseNo ? `${meta.clauseNo} ${meta.clauseTitle || ''}` : (meta?.clauseTitle || '')
    const page = meta?.pageRange ? `（第${meta.pageRange[0]}-${meta.pageRange[1]}页）` : ''
    const ocrTag = meta?.sourceType === 'ocr' ? ' [OCR识别，建议核对原件]' : ''
    return `[参考${i + 1}] 来源：${doc.title}${locator ? ' · ' + locator.trim() : ''}${page}${ocrTag}\n${doc.content}`
  }).join('\n\n---\n\n')
}

interface RagOptions extends RetrieveOptions {
  /** 会话历史（由调用方从 DB 加载），用于指代消解与多轮上下文；最后一条应为当前用户问题之前的对话 */
  history?: HistoryTurn[]
  callbacks?: BaseCallbackHandler[]
}

// ── 流式 RAG ──────────────────────────────────────────────────
export async function ragQueryStream(question: string, options: RagOptions = {}) {
  const { history = [], callbacks, ...retrieveOptions } = options
  const rewrittenQuestion = await rewriteWithHistory(question, history, callbacks)
  const docs = await retrieveDocs(rewrittenQuestion, retrieveOptions)

  return {
    sources: docs,
    rewrittenQuestion,
    async *streamAnswer() {
      if (!docs.length) {
        yield '知识库中未找到与该问题相关的内容。\n请尝试换一种提问方式，或上传相关文档后再试。'
        return
      }

      // 抽取式摘要：只挑相关句子，绝不改写原文（消除 LLM 压缩引入的幻觉）
      const extractedDocs = docs.map((doc) => ({
        ...doc,
        content: extractRelevantSentences(doc.content, rewrittenQuestion),
      }))
      const sourceContents = docs.map((d) => d.content)

      const prompt = ChatPromptTemplate.fromMessages([
        ['system', RAG_SYSTEM],
        ...history.map((m) => [m.role === 'user' ? 'human' : 'assistant', m.content] as any),
        ['human', `参考文档：\n${buildContext(extractedDocs as any)}\n\n问题：${question}`],
      ])

      // 收集完整回答后做数字校验，再输出（防幻觉优先于流式实时性）
      let fullAnswer = ''
      const stream = await prompt.pipe(chatModel).stream({}, { callbacks })
      for await (const chunk of stream) {
        if (chunk.content) fullAnswer += chunk.content
      }

      // 数字专项校验：回答中的金额/比例/期限必须能在原文中找到
      const verified = verifyNumbersInAnswer(fullAnswer, sourceContents)
      yield verified
    },
  }
}
