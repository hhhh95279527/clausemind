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

export interface RetrieveOptions {
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
const RAG_SYSTEM = `你是 ClauseMind AI 知识库助手，是一个严谨的智能问答系统。

## 核心规则
1. 只根据下方提供的参考文档回答，绝不使用文档之外的知识
2. 如果文档中没有相关内容，明确回复"知识库中未找到相关内容"
3. 回答要准确、简洁、有条理，必要时使用要点列表
4. 对具体数据（数字、日期、名称）必须与原文一致；文档间有矛盾时如实指出
5. 回答末尾另起一行，用 【来源：文档名】 格式标注引用了哪些文档`

const COMPRESS_PROMPT = `请从以下参考文档中提取与问题最相关的内容，保留关键数据、结论和论据。
直接输出精简后的内容，不要加额外说明。

问题：{question}

文档内容：{content}`

async function compressDoc(content: string, question: string, callbacks?: BaseCallbackHandler[]): Promise<string> {
  if (content.length < 300) return content
  try {
    const prompt = ChatPromptTemplate.fromMessages([['human', COMPRESS_PROMPT]])
    return await prompt.pipe(chatModel).pipe(new StringOutputParser())
      .invoke({ question, content }, { callbacks })
  } catch {
    return content
  }
}

function buildContext(docs: RetrievedChunk[]): string {
  return docs.map((doc, i) => `[参考${i + 1}] 来源：${doc.title}\n${doc.content}`).join('\n\n---\n\n')
}

interface RagOptions extends RetrieveOptions {
  /** 会话历史（由调用方从 DB 加载），用于指代消解与多轮上下文；最后一条应为当前用户问题之前的对话 */
  history?: HistoryTurn[]
  callbacks?: BaseCallbackHandler[]
}

// ── 非流式 RAG（支持历史记忆）──────────────────────────────────
export async function ragQuery(question: string, options: RagOptions = {}) {
  const { history = [], callbacks, ...retrieveOptions } = options
  const rewrittenQuestion = await rewriteWithHistory(question, history, callbacks)
  const docs = await retrieveDocs(rewrittenQuestion, retrieveOptions)

  if (!docs.length) {
    return {
      answer: '知识库中未找到与该问题相关的内容。请尝试换一种提问方式，或上传相关文档后再试。',
      sources: [],
    }
  }

  const compressedDocs = await Promise.all(
    docs.map(async (doc) => ({ ...doc, content: await compressDoc(doc.content, rewrittenQuestion, callbacks) })),
  )
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', RAG_SYSTEM],
    ...history.map((m) => [m.role === 'user' ? 'human' : 'assistant', m.content] as any),
    ['human', `参考文档：\n${buildContext(compressedDocs as any)}\n\n问题：${question}`],
  ])
  const answer = await prompt.pipe(chatModel).pipe(new StringOutputParser()).invoke({}, { callbacks })
  return { answer, sources: docs }
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

      const compressedDocs = await Promise.all(
        docs.map(async (doc) => ({ ...doc, content: await compressDoc(doc.content, rewrittenQuestion, callbacks) })),
      )
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', RAG_SYSTEM],
        ...history.map((m) => [m.role === 'user' ? 'human' : 'assistant', m.content] as any),
        ['human', `参考文档：\n${buildContext(compressedDocs as any)}\n\n问题：${question}`],
      ])

      const stream = await prompt.pipe(chatModel).stream({}, { callbacks })
      for await (const chunk of stream) {
        if (chunk.content) yield chunk.content
      }
    },
  }
}
