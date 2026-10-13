// server/src/monitor/monitor.service.ts
// 调用链路数据源：租户瀑布页（listTraces/getTraceDetail）与平台超管跨租户查询。
// 所有租户侧查询强制带 tenantId —— 链路数据也是租户隔离的。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'

const FEATURE_NAMES: Record<string, string> = {
  chat: '对话助手',
  knowledge: 'RAG 知识库',
  agent: '任务 Agent',
  contract_review: '合同审查',
  eval: '离线评测',
}

@Injectable()
export class MonitorService {
  constructor(private readonly db: DatabaseService) {}

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
