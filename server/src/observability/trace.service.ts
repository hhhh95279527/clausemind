// server/src/observability/trace.service.ts
// 链路服务：一条业务请求 = 一条 Trace；模型/工具调用自动落为 Span。
// 结束时统一回写聚合 token、峰谷成本、时延，并累计租户月度配额用量。
import { Injectable, OnModuleInit } from '@nestjs/common'
import { TraceStatus } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'
import { config } from '../config/index.js'
import { createContext, runInContext, type TraceContext } from './trace-context.js'
import { ClauseMindObserver, setObserverDatabase } from './langchain-observer.js'
import { calcCostCny } from './pricing.js'
import { QuotaService } from './quota.service.js'
import { logger } from '../utils/logger.js'

export interface TraceInput {
  feature: string
  name: string
  tenantId?: string | null
  userId?: string | null
}

export interface TraceHandle {
  ctx: TraceContext
  /** 传给 LangChain 调用的 callbacks，自动产生 Span */
  callbacks: [ClauseMindObserver]
  /** 标记本次为精确缓存命中（零成本，不计配额） */
  markCacheHit(savedTokens: number): void
}

@Injectable()
export class TraceService implements OnModuleInit {
  private readonly observer = new ClauseMindObserver()

  constructor(
    private readonly db: DatabaseService,
    private readonly quota: QuotaService,
  ) {}

  onModuleInit() {
    setObserverDatabase(this.db)
  }

  /** 在链路上下文中执行业务函数；自动以 OK/ERROR 收口，异常会原样向上抛 */
  async run<T>(input: TraceInput, fn: (handle: TraceHandle) => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    const trace = await this.db.trace.create({
      data: {
        feature: input.feature,
        name: input.name.slice(0, 200),
        tenantId: input.tenantId ?? null,
        userId: input.userId ?? null,
        status: TraceStatus.RUNNING,
      },
    })

    const ctx = createContext({
      traceId: trace.id,
      feature: input.feature,
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
    })
    const handle: TraceHandle = {
      ctx,
      callbacks: [this.observer],
      markCacheHit(savedTokens) {
        ctx.cacheHit = true
        ctx.usage.inputTokens = savedTokens
      },
    }

    try {
      const result = await runInContext(ctx, () => fn(handle))
      await this.finish(ctx, trace.id, startedAt, TraceStatus.OK)
      return result
    } catch (err) {
      await this.finish(ctx, trace.id, startedAt, TraceStatus.ERROR, err as Error).catch(() => {})
      throw err
    }
  }

  private async finish(ctx: TraceContext, traceId: string, startedAt: number, status: TraceStatus, err?: Error) {
    const latencyMs = Date.now() - startedAt

    // 缓存命中：不产生供应商费用，也不占用月度 token 配额
    if (ctx.cacheHit) {
      await this.db.trace.update({
        where: { id: traceId },
        data: {
          status,
          model: 'cache',
          inputTokens: ctx.usage.inputTokens,
          latencyMs,
          error: err?.message.slice(0, 2000) ?? null,
        },
      })
      return
    }

    const model = ctx.model || config.ai.primaryModel
    const { costCny } = calcCostCny(model, ctx.usage)

    await this.db.trace.update({
      where: { id: traceId },
      data: {
        status,
        model,
        inputTokens: ctx.usage.inputTokens,
        outputTokens: ctx.usage.outputTokens,
        costCny,
        latencyMs,
        error: err?.message.slice(0, 2000) ?? null,
      },
    })

    if (ctx.tenantId && (ctx.usage.inputTokens + ctx.usage.outputTokens) > 0) {
      await this.quota.record(
        ctx.tenantId,
        ctx.usage.inputTokens,
        ctx.usage.outputTokens,
        costCny,
      ).catch((e) => logger.warn('quota record failed', { error: e.message }))
    }
  }
}
