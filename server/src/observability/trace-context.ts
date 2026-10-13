// server/src/observability/trace-context.ts
// 基于 AsyncLocalStorage 的链路上下文：一次请求内任意深层代码（模型调用、工具、RAG）
// 无需层层传参即可拿到当前 traceId，这是 OpenTelemetry Context 的同款机制。
import { AsyncLocalStorage } from 'async_hooks'
import type { TokenUsage } from './pricing.js'

export interface TraceContext {
  traceId: string
  tenantId: string | null
  userId: string | null
  feature: string
  /** 本次链路实际调用到的模型名（由 LLM 回调回填） */
  model?: string
  /** 跨多次 LLM 调用（Agent 多步）累加的用量 */
  usage: Required<TokenUsage>
  /** 跨多次 LLM 调用按各自真实模型累加的费用（元）；一条链路混用多模型时与 usage 分开计价 */
  costCny: number
}

export function createContext(init: Omit<TraceContext, 'usage' | 'costCny'> & { usage?: TokenUsage }): TraceContext {
  return {
    ...init,
    costCny: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      ...init.usage,
    },
  }
}

const storage = new AsyncLocalStorage<TraceContext>()

/** 在 trace 上下文中执行函数，await 返回其结果 */
export function runInContext<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

/** 获取当前链路上下文，不存在返回 undefined（非链路内调用时） */
export function activeContext(): TraceContext | undefined {
  return storage.getStore()
}
