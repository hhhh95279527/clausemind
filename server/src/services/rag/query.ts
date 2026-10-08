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
import { rewriteQuery, addMessage, getMessageHistory } from './memory.js'

const FINAL_K = 4          // 最终保留的文档数
const MULTI_QUERY_COUNT = 3 // 多查询扩展的变体数量

const QUERY_EXPANSION_PROMPT = `你是一个擅长从不同角度理解问题的助手。
给定用户的一个问题，请从 {count} 个不同的角度改写这个问题，使其更容易在知识库中检索到相关内容。
每个变体用单独的 {n}. 开头，直接输出问题本身，不要多余的解释。`

function parseQueryVariants(text: string): string[] {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+\./.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
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
    const all = [question, ...variants.filter((v) => v && v !== question)]
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
}

// ── 检索：多查询变体合并去重（内部以单变体分数最高者为准）──────────
export async function retrieveDocs(question: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const db = getRagDatabase()
  if (!db) return []

  const k = opts.k ?? FINAL_K
  const tenantId = opts.tenantId ?? activeContext()?.tenantId ?? null
  const queries = await expandQuery(question)

  const merged = new Map<string, RetrievedChunk>()
  for (const q of queries) {
    const docs = await retrieveFromPg(db as any, q, {
      k,
      docType: opts.docType,
      category: opts.category,
      tenantId,
    })
    for (const d of docs) {
      const key = d.chunkId
      if (!merged.has(key) || d.score > merged.get(key)!.score) merged.set(key, d)
    }
  }

  const top = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k)
  logger.info('rag: retrieved docs', {
    question: question.slice(0, 40),
    queries: queries.length,
    total: merged.size,
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
  sessionId?: string
  callbacks?: BaseCallbackHandler[]
}

// ── 非流式 RAG（支持历史记忆）──────────────────────────────────
export async function ragQuery(question: string, options: RagOptions = {}) {
  const { sessionId, callbacks, ...retrieveOptions } = options
  const rewrittenQuestion = sessionId ? await rewriteQuery(question, sessionId) : question
  const docs = await retrieveDocs(rewrittenQuestion, retrieveOptions)

  if (!docs.length) {
    const answer = '知识库中未找到与该问题相关的内容。请尝试换一种提问方式，或上传相关文档后再试。'
    if (sessionId) {
      addMessage(sessionId, 'user', question)
      addMessage(sessionId, 'assistant', answer)
    }
    return { answer, sources: [] }
  }

  const compressedDocs = await Promise.all(
    docs.map(async (doc) => ({ ...doc, content: await compressDoc(doc.content, rewrittenQuestion, callbacks) })),
  )
  const historyMessages = sessionId ? getMessageHistory(sessionId) : []
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', RAG_SYSTEM],
    ...historyMessages.map((m: any) => [m.role === 'user' ? 'human' : 'assistant', m.content] as any),
    ['human', `参考文档：\n${buildContext(compressedDocs as any)}\n\n问题：${question}`],
  ])
  const answer = await prompt.pipe(chatModel).pipe(new StringOutputParser()).invoke({}, { callbacks })

  if (sessionId) {
    addMessage(sessionId, 'user', question)
    addMessage(sessionId, 'assistant', answer)
  }
  return { answer, sources: docs }
}

// ── 流式 RAG ──────────────────────────────────────────────────
export async function ragQueryStream(question: string, options: RagOptions = {}) {
  const { sessionId, callbacks, ...retrieveOptions } = options
  const rewrittenQuestion = sessionId ? await rewriteQuery(question, sessionId) : question
  const docs = await retrieveDocs(rewrittenQuestion, retrieveOptions)
  if (sessionId) addMessage(sessionId, 'user', question)

  return {
    sources: docs,
    rewrittenQuestion,
    async *streamAnswer() {
      if (!docs.length) {
        const answer = '知识库中未找到与该问题相关的内容。\n请尝试换一种提问方式，或上传相关文档后再试。'
        if (sessionId) addMessage(sessionId, 'assistant', answer)
        yield answer
        return
      }

      const compressedDocs = await Promise.all(
        docs.map(async (doc) => ({ ...doc, content: await compressDoc(doc.content, rewrittenQuestion, callbacks) })),
      )
      const historyMessages = sessionId ? getMessageHistory(sessionId) : []
      const previousHistory = historyMessages.slice(0, -1)
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', RAG_SYSTEM],
        ...previousHistory.map((m: any) => [m.role === 'user' ? 'human' : 'assistant', m.content] as any),
        ['human', `参考文档：\n${buildContext(compressedDocs as any)}\n\n问题：${question}`],
      ])

      const stream = await prompt.pipe(chatModel).stream({}, { callbacks })
      let fullAnswer = ''
      for await (const chunk of stream) {
        if (chunk.content) {
          fullAnswer += chunk.content
          yield chunk.content
        }
      }
      if (sessionId) addMessage(sessionId, 'assistant', fullAnswer)
    },
  }
}
