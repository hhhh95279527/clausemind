// server/src/observability/langchain-observer.ts
// LangChain 回调观察者：把 LLM / Tool 调用自动转成 Span 落库，并累加整条链路的 token 与成本。
// 业务侧只需 model.invoke(msgs, { callbacks: [observer] })，Agent 内部多轮调用会被自动穿透。
import { SpanType } from '@prisma/client'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult } from '@langchain/core/outputs'
import type { DatabaseService } from '../database/database.service.js'
import { activeContext } from './trace-context.js'
import { calcCostCny, type TokenUsage } from './pricing.js'
import { logger } from '../utils/logger.js'

/** 供模块初始化时注入 Prisma（回调体系早于 Nest 容器存在，无法 constructor 注入） */
let db: DatabaseService | null = null
export function setObserverDatabase(client: DatabaseService) {
  db = client
}

interface RunningCall {
  startedAt: number
  name: string
  input?: unknown
}

// 序列化时的长度上限，防止异常大输出把 spans 表撑爆
const MAX_TEXT = 2000

function truncate(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value
  try {
    const json = JSON.stringify(value)
    return json.length > MAX_TEXT ? json.slice(0, MAX_TEXT) + '…' : value
  } catch {
    return '[unserializable]'
  }
}

/**
 * 从 LangChain LLMResult 中提取用量，兼容三种来源：
 * 1. usage_metadata（LangChain 标准，含 input_token_details.cache_read）
 * 2. response_metadata.usage（OpenAI 兼容原始 usage）
 * 3. llmOutput.tokenUsage（部分集成）
 */
export function extractUsage(output: LLMResult): { model?: string; usage: TokenUsage } {
  const message: any = (output.generations?.[0]?.[0] as any)?.message
  const um = message?.usage_metadata
  const raw: any = message?.response_metadata?.usage
    ?? output.llmOutput?.tokenUsage
    ?? output.llmOutput?.estimatedTokenUsage

  let model = message?.response_metadata?.model
  const inputTokens = um?.input_tokens ?? raw?.prompt_tokens ?? 0
  const outputTokens = um?.output_tokens ?? raw?.completion_tokens ?? 0
  const cacheHitTokens = um?.input_token_details?.cache_read
    ?? raw?.prompt_cache_hit_tokens
    ?? 0
  return { model, usage: { inputTokens, outputTokens, cacheHitTokens } }
}

export class ClauseMindObserver extends BaseCallbackHandler {
  name = 'clausemind-observer'

  private running = new Map<string, RunningCall>()

  async handleLLMStart(_llm: unknown, prompts: string[], runId: string, _parentId: string | undefined, extra: any) {
    if (!activeContext() || !db) return
    this.running.set(runId, {
      startedAt: Date.now(),
      name: extra?.model || extra?.model_name || extra?.modelName || 'llm',
      input: { promptChars: prompts.reduce((s, p) => s + (p?.length || 0), 0) },
    })
  }

  async handleLLMEnd(output: LLMResult, runId: string) {
    const ctx = activeContext()
    const call = this.running.get(runId)
    this.running.delete(runId)
    if (!ctx || !call || !db) return

    const { model, usage } = extractUsage(output)
    if (model) ctx.model = model
    const finalModel = model || call.name || 'deepseek-chat'
    const cost = calcCostCny(finalModel, usage)

    // 累加链路级用量（Agent 一轮可能产生多次 LLM 调用）
    ctx.usage.inputTokens += usage.inputTokens || 0
    ctx.usage.outputTokens += usage.outputTokens || 0
    ctx.usage.cacheHitTokens += usage.cacheHitTokens || 0

    await db.span.create({
      data: {
        traceId: ctx.traceId,
        type: 'LLM',
        name: finalModel,
        startedAt: new Date(call.startedAt),
        durationMs: Date.now() - call.startedAt,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        costCny: cost.costCny,
        metadata: { peak: cost.peak, cacheHitTokens: usage.cacheHitTokens || 0 },
      },
    }).catch((e) => logger.warn('span(LLM) persist failed', { error: e.message }))
  }

  async handleLLMError(err: Error, runId: string) {
    const ctx = activeContext()
    const call = this.running.get(runId)
    this.running.delete(runId)
    if (!ctx || !call || !db) return
    await db.span.create({
      data: {
        traceId: ctx.traceId,
        type: 'LLM',
        name: call.name,
        startedAt: new Date(call.startedAt),
        durationMs: Date.now() - call.startedAt,
        metadata: { error: err.message.slice(0, 500) },
      },
    }).catch(() => {})
  }

  async handleToolStart(serialized: any, input: unknown, runId: string) {
    if (!activeContext() || !db) return
    this.running.set(runId, {
      startedAt: Date.now(),
      name: serialized?.name || 'tool',
      input: truncate(input),
    })
  }

  async handleToolEnd(output: unknown, runId: string) {
    const ctx = activeContext()
    const call = this.running.get(runId)
    this.running.delete(runId)
    if (!ctx || !call || !db) return
    await db.span.create({
      data: {
        traceId: ctx.traceId,
        type: SpanType.TOOL,
        name: call.name,
        startedAt: new Date(call.startedAt),
        durationMs: Date.now() - call.startedAt,
        input: call.input as any,
        output: truncate(typeof output === 'string' ? output : JSON.stringify(output)) as any,
      },
    }).catch((e) => logger.warn('span(TOOL) persist failed', { error: e.message }))
  }
}

/**
 * 手动记录 RETRIEVER Span：向量/关键词检索不是 LangChain 标准回调对象，
 * 由检索层在 Trace 上下文内主动调用。无活动 Trace 时静默跳过。
 */
export async function recordRetrieverSpan(
  name: string,
  input: { query: string; mode: string; k: number },
  output: { count: number; topScore?: number; titles?: string[] },
  durationMs: number,
): Promise<void> {
  const ctx = activeContext()
  if (!ctx || !db) return
  await db.span.create({
    data: {
      traceId: ctx.traceId,
      type: SpanType.RETRIEVER,
      name,
      durationMs,
      input: input as any,
      output: truncate(output) as any,
    },
  }).catch((e) => logger.warn('span(RETRIEVER) persist failed', { error: e.message }))
}
