// server/src/monitor/monitor.service.ts
// 用量看板：数据源已从内存数组切换为 traces 表（与账单、Eval 同源，重启不丢）。
// 所有查询强制带 tenantId —— 看板也是租户隔离的。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { cache } from '../services/cache.js'

const FEATURE_NAMES: Record<string, string> = {
  chat: '对话助手',
  knowledge: 'RAG 知识库',
  agent: '任务 Agent',
  contract_review: '合同审查',
  eval: '离线评测',
}

interface DayRow { date: string; total: number; api: number; input: number; output: number; cost: number }

@Injectable()
export class MonitorService {
  private readonly startTime = Date.now()
  // 日预算（元）：P3 改为按租户系统配置，当前内存态足够演示
  private dailyBudget = 50

  constructor(private readonly db: DatabaseService) {}

  async getStats(tenantId: string) {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 86_400_000)

    const base = { tenantId, createdAt: { gte: todayStart } }

    const [totalAgg, cacheCount, errorCount, recent, latency, sevenRows, featureGroups] = await Promise.all([
      // 今日总量/成本/token
      this.db.trace.aggregate({
        where: base,
        _sum: { inputTokens: true, outputTokens: true, costCny: true },
        _count: true,
      }),
      this.db.trace.count({ where: { ...base, model: 'cache' } }),
      this.db.trace.count({ where: { ...base, status: 'ERROR' } }),
      // 最近 50 条
      this.db.trace.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      // P50/P90/P99：仅统计真实模型调用（排除缓存命中与失败）
      this.db.$queryRaw<any>`
        SELECT
          percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::float AS p50,
          percentile_cont(0.90) WITHIN GROUP (ORDER BY latency_ms)::float AS p90,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::float AS p99,
          COALESCE(AVG(latency_ms), 0)::float AS avg
        FROM traces
        WHERE tenant_id = ${tenantId}
          AND created_at >= ${todayStart}
          AND status = 'OK' AND model <> 'cache' AND latency_ms > 0
      `,
      // 近 7 天（SQL date_trunc 按天聚合，JS 补空白天）
      this.db.$queryRaw<DayRow[]>`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE model <> 'cache')::int AS api,
               COALESCE(SUM(input_tokens), 0)::int  AS input,
               COALESCE(SUM(output_tokens), 0)::int AS output,
               COALESCE(SUM(cost_cny), 0)::float    AS cost
        FROM traces
        WHERE tenant_id = ${tenantId} AND created_at >= ${sevenDaysAgo}
        GROUP BY 1 ORDER BY 1
      `,
      // 今日按功能分布
      this.db.trace.groupBy({
        by: ['feature'],
        where: base,
        _count: true,
        _sum: { inputTokens: true, outputTokens: true, costCny: true },
      }),
    ])

    const totalCalls = totalAgg._count
    const cacheHits = cacheCount
    const costCnyToday = Number(totalAgg._sum.costCny ?? 0)

    return {
      overview: {
        totalCallsToday: totalCalls,
        apiCallsToday: totalCalls - cacheHits,
        cacheHitsToday: cacheHits,
        cacheHitRate: totalCalls ? `${((cacheHits / totalCalls) * 100).toFixed(1)}%` : '0%',
        successRate: totalCalls ? `${(((totalCalls - errorCount) / totalCalls) * 100).toFixed(1)}%` : '100%',
        tokenInputToday: totalAgg._sum.inputTokens ?? 0,
        tokenOutputToday: totalAgg._sum.outputTokens ?? 0,
        costCnyToday: Number(costCnyToday.toFixed(4)),
        dailyBudget: this.dailyBudget,
        budgetUsedPct: Math.min(100, Number(((costCnyToday / this.dailyBudget) * 100).toFixed(1))),
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      },
      latency: {
        p50: Math.round(latency[0]?.p50 ?? 0),
        p90: Math.round(latency[0]?.p90 ?? 0),
        p99: Math.round(latency[0]?.p99 ?? 0),
        avg: Math.round(latency[0]?.avg ?? 0),
      },
      byFeature: featureGroups
        .map((g) => ({
          feature: g.feature,
          label: FEATURE_NAMES[g.feature] || g.feature,
          calls: g._count,
          costCny: Number(Number(g._sum.costCny ?? 0).toFixed(4)),
          tokens: (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0),
        }))
        .sort((a, b) => b.calls - a.calls),
      last7Days: this.fillSevenDays(sevenRows),
      recentCalls: recent.map((t) => ({
        id: t.id,
        time: t.createdAt.toISOString(),
        feature: t.feature,
        name: t.name,
        status: t.status,
        model: t.model,
        inputT: t.inputTokens,
        outputT: t.outputTokens,
        costCNY: Number(t.costCny),
        latencyMs: t.latencyMs,
        fromCache: t.model === 'cache',
        error: t.error,
      })),
      cacheStats: cache.getStats(),
    }
  }

  /** SQL 只返回有数据的天，这里补齐 7 天序列让前端图表不断点 */
  private fillSevenDays(rows: DayRow[]) {
    const byDate = new Map(rows.map((r) => [r.date, r]))
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const row = byDate.get(key)
      days.push({
        date: key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        totalCalls: Number(row?.total ?? 0),
        apiCalls: Number(row?.api ?? 0),
        inputT: Number(row?.input ?? 0),
        outputT: Number(row?.output ?? 0),
        costCNY: Number(Number(row?.cost ?? 0).toFixed(4)),
      })
    }
    return days
  }

  // ── Trace 瀑布页数据源 ───────────────────────────────────────
  /** 链路列表：分页 + feature/status 过滤，强制租户隔离 */
  async listTraces(
    tenantId: string,
    opts: { page: number; pageSize: number; feature?: string; status?: string },
  ) {
    const { page, pageSize } = opts
    const where: any = { tenantId }
    if (opts.feature) where.feature = opts.feature
    if (opts.status === 'OK' || opts.status === 'ERROR') where.status = opts.status

    const [rows, total] = await Promise.all([
      this.db.trace.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.trace.count({ where }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((t) => ({
        id: t.id,
        feature: t.feature,
        label: FEATURE_NAMES[t.feature] || t.feature,
        name: t.name,
        status: t.status,
        model: t.model,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        tokens: t.inputTokens + t.outputTokens,
        costCny: Number(t.costCny),
        latencyMs: t.latencyMs,
        error: t.error,
        createdAt: t.createdAt.toISOString(),
      })),
    }
  }

  /** 链路详情：trace + 按开始时间升序的 spans（瀑布时间轴由前端按 startedAt 算偏移） */
  async getTraceDetail(tenantId: string, id: string) {
    const trace = await this.db.trace.findFirst({ where: { id, tenantId } })
    if (!trace) return null

    const spans = await this.db.span.findMany({
      where: { traceId: trace.id },
      orderBy: { startedAt: 'asc' },
    })

    return {
      id: trace.id,
      feature: trace.feature,
      label: FEATURE_NAMES[trace.feature] || trace.feature,
      name: trace.name,
      status: trace.status,
      model: trace.model,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      costCny: Number(trace.costCny),
      latencyMs: trace.latencyMs,
      error: trace.error,
      startedAt: trace.createdAt.toISOString(),
      spans: spans.map((s) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        startedAt: s.startedAt.toISOString(),
        durationMs: s.durationMs,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        costCny: Number(s.costCny),
        input: s.input,
        output: s.output,
        metadata: s.metadata,
      })),
    }
  }

  setBudget(dailyBudget: number) {
    this.dailyBudget = dailyBudget
  }

  // ── 平台超管：跨租户 Trace 查询（不强制 tenantId，用于缺陷排查） ──

  /** 跨租户链路列表：支持 tenantId / plan / feature / status 过滤，附带 tenantName 与 submitter */
  async listAllTraces(opts: {
    page: number
    pageSize: number
    tenantId?: string
    plan?: string
    feature?: string
    status?: string
  }) {
    const { page, pageSize } = opts
    const where: any = {}
    if (opts.tenantId) where.tenantId = opts.tenantId
    if (opts.feature) where.feature = opts.feature
    if (opts.status === 'OK' || opts.status === 'ERROR') where.status = opts.status

    // plan 过滤需 join tenant
    const planFilter = ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'].includes(opts.plan || '') ? opts.plan : null

    const whereWithTenant: any = {
      ...where,
      ...(planFilter && { tenant: { plan: planFilter as any } }),
    }

    const [rows, total] = await Promise.all([
      this.db.trace.findMany({
        where: whereWithTenant,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          tenant: { select: { name: true, plan: true } },
          user: { select: { username: true, displayName: true } },
        },
      }),
      this.db.trace.count({ where: whereWithTenant }),
    ])

    return {
      total,
      page,
      pageSize,
      items: rows.map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        tenantName: t.tenant?.name ?? '-',
        tenantPlan: t.tenant?.plan ?? '-',
        submitter: t.user ? (t.user.displayName || t.user.username) : '-',
        feature: t.feature,
        label: FEATURE_NAMES[t.feature] || t.feature,
        name: t.name,
        status: t.status,
        model: t.model,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        tokens: t.inputTokens + t.outputTokens,
        costCny: Number(t.costCny),
        latencyMs: t.latencyMs,
        error: t.error,
        createdAt: t.createdAt.toISOString(),
      })),
    }
  }

  /** 跨租户链路详情：不校验 tenantId，平台超管可查看任意 trace */
  async getTraceDetailById(id: string) {
    const trace = await this.db.trace.findFirst({
      where: { id },
      include: {
        tenant: { select: { name: true, plan: true } },
        user: { select: { username: true, displayName: true } },
      },
    })
    if (!trace) return null

    const spans = await this.db.span.findMany({
      where: { traceId: trace.id },
      orderBy: { startedAt: 'asc' },
    })

    return {
      id: trace.id,
      tenantId: trace.tenantId,
      tenantName: trace.tenant?.name ?? '-',
      tenantPlan: trace.tenant?.plan ?? '-',
      submitter: trace.user ? (trace.user.displayName || trace.user.username) : '-',
      feature: trace.feature,
      label: FEATURE_NAMES[trace.feature] || trace.feature,
      name: trace.name,
      status: trace.status,
      model: trace.model,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      costCny: Number(trace.costCny),
      latencyMs: trace.latencyMs,
      error: trace.error,
      startedAt: trace.createdAt.toISOString(),
      spans: spans.map((s) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        startedAt: s.startedAt.toISOString(),
        durationMs: s.durationMs,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        costCny: Number(s.costCny),
        input: s.input,
        output: s.output,
        metadata: s.metadata,
      })),
    }
  }
}
