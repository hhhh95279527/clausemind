// server/src/monitor/billing.service.ts
// 配额账单数据源：月度配额（quota_usage）+ 按天峰谷费用 / 按功能占比（traces 聚合）。
// 与 pricing.ts 的峰谷口径保持一致：北京时间工作日 09-12、14-18 为高峰，其余为空闲半价。
// 普通租户只查自己；ADMIN 可指定任意 tenantId 或拉全部租户汇总。
import { ForbiddenException, Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { currentPeriod } from '../observability/quota.service.js'

const FEATURE_LABELS: Record<string, string> = {
  chat: '对话助手',
  knowledge: 'RAG 知识库',
  agent: '任务 Agent',
  contract_review: '合同审查',
  contract_parse: '合同解析',
  eval: '离线评测',
}

interface DailyRaw {
  date: string
  peak: boolean
  calls: number
  tokens: number
  cost: number
}

@Injectable()
export class BillingService {
  constructor(private readonly db: DatabaseService) {}

  /** 北京时间当前账期的月初（以 UTC 时刻表示，供 created_at >= 比较） */
  private monthStartUtc(period: string): Date {
    const [y, m] = period.split('-').map(Number)
    // 北京 1 号 00:00 = UTC 上月最后一天 16:00
    return new Date(Date.UTC(y, m - 1, 1) - 8 * 3600_000)
  }

  /** 北京时区今天是本月第几天（1-based），用于补齐当月空白天 */
  private beijingDayOfMonth(now = new Date()): number {
    return new Date(now.getTime() + 8 * 3600_000).getUTCDate()
  }

  /** 单租户账单概览（self 或 ADMIN 代查） */
  async getBilling(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new ForbiddenException('租户不存在')

    const period = currentPeriod()
    const monthStart = this.monthStartUtc(period)

    const [usageRow, monthlyRows, featureGroups, agg, dailyRaw] = await Promise.all([
      this.db.quotaUsage.findUnique({
        where: { tenantId_period: { tenantId, period } },
      }),
      this.db.quotaUsage.findMany({ where: { tenantId }, orderBy: { period: 'desc' } }),
      this.db.trace.groupBy({
        by: ['feature'],
        where: { tenantId, createdAt: { gte: monthStart } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, costCny: true },
      }),
      this.db.trace.aggregate({
        where: { tenantId, createdAt: { gte: monthStart } },
        _sum: { inputTokens: true, outputTokens: true, costCny: true },
        _count: { _all: true },
      }),
      // 峰/谷按北京时间工作日与小时判定（列存的是 UTC 墙钟时间）
      this.db.$queryRaw<DailyRaw[]>`
        SELECT date, peak, COUNT(*)::int AS calls,
               COALESCE(SUM(input_tokens + output_tokens), 0)::float AS tokens,
               COALESCE(SUM(cost_cny), 0)::float AS cost
        FROM (
          SELECT to_char(bj, 'YYYY-MM-DD') AS date,
                 (EXTRACT(DOW FROM bj) BETWEEN 1 AND 5
                  AND EXTRACT(HOUR FROM bj) IN (9, 10, 11, 14, 15, 16, 17)) AS peak,
                 input_tokens, output_tokens, cost_cny
          FROM traces,
               LATERAL (SELECT created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS conv(bj)
          WHERE tenant_id = ${tenantId} AND created_at >= ${monthStart}
        ) z
        GROUP BY date, peak
        ORDER BY date
      `,
    ])

    const inputTokens = usageRow ? Number(usageRow.inputTokens) : 0
    const outputTokens = usageRow ? Number(usageRow.outputTokens) : 0
    const usedTokens = inputTokens + outputTokens
    const costCny = usageRow ? Number(usageRow.costCny) : 0
    const quota = tenant.monthlyTokenQuota
    const usedPct = quota ? Number(((usedTokens / quota) * 100).toFixed(2)) : 0

    // ── 按天合并峰/谷两行，并补齐当月 1 号至今天 ──
    const byDate = new Map<string, { peak: number; off: number; tokens: number; calls: number }>()
    for (const r of dailyRaw) {
      const row = byDate.get(r.date) ?? { peak: 0, off: 0, tokens: 0, calls: 0 }
      if (r.peak) row.peak += r.cost
      else row.off += r.cost
      row.tokens += r.tokens
      row.calls += r.calls
      byDate.set(r.date, row)
    }
    const daily = []
    for (let d = 1; d <= this.beijingDayOfMonth(); d++) {
      const key = `${period}-${String(d).padStart(2, '0')}`
      const row = byDate.get(key)
      daily.push({
        date: key,
        label: `${d}`,
        peakCost: Number((row?.peak ?? 0).toFixed(4)),
        offPeakCost: Number((row?.off ?? 0).toFixed(4)),
        costCny: Number(((row?.peak ?? 0) + (row?.off ?? 0)).toFixed(4)),
        tokens: Math.round(row?.tokens ?? 0),
        calls: row?.calls ?? 0,
      })
    }

    // ── 功能占比（按费用）──
    const totalFeatureCost = featureGroups.reduce((s, g) => s + Number(g._sum.costCny ?? 0), 0)
    const byFeature = featureGroups
      .map((g) => {
        const cost = Number(g._sum.costCny ?? 0)
        return {
          feature: g.feature,
          label: FEATURE_LABELS[g.feature] || g.feature,
          calls: g._count._all,
          tokens: (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0),
          costCny: Number(cost.toFixed(4)),
          costPct: totalFeatureCost ? Number(((cost / totalFeatureCost) * 100).toFixed(1)) : 0,
        }
      })
      .sort((a, b) => b.costCny - a.costCny)

    // ── 历史账期（超额记录 = 用量触顶的账期）──
    const monthly = monthlyRows.map((r) => {
      const used = Number(r.inputTokens) + Number(r.outputTokens)
      return {
        period: r.period,
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        usedTokens: used,
        costCny: Number(r.costCny),
        usedPct: quota ? Number(((used / quota) * 100).toFixed(1)) : 0,
        overLimit: used >= quota,
        updatedAt: r.updatedAt.toISOString(),
      }
    })
    const overLimitMonths = monthly.filter((m) => m.overLimit)

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        status: tenant.status,
        quota,
      },
      period,
      usage: {
        inputTokens,
        outputTokens,
        usedTokens,
        costCny: Number(costCny.toFixed(4)),
        usedPct,
        overLimit: usedTokens >= quota,
      },
      monthTotals: {
        calls: agg._count._all,
        tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0),
        costCny: Number(Number(agg._sum.costCny ?? 0).toFixed(4)),
      },
      daily,
      byFeature,
      monthly,
      overLimitMonths,
    }
  }

  /** ADMIN：全部租户当前账期汇总（费用倒序） */
  async listTenantBilling(period = currentPeriod()) {
    const rows = await this.db.$queryRaw<
      Array<{
        tenant_id: string
        name: string
        plan: string
        status: string
        quota: number
        input_tokens: number
        output_tokens: number
        cost: number
      }>
    >`
      SELECT t.id AS tenant_id, t.name, t.plan, t.status,
             t.monthly_token_quota AS quota,
             COALESCE(q.input_tokens, 0)::float  AS input_tokens,
             COALESCE(q.output_tokens, 0)::float AS output_tokens,
             COALESCE(q.cost_cny, 0)::float      AS cost
      FROM tenants t
      LEFT JOIN quota_usage q ON q.tenant_id = t.id AND q.period = ${period}
      ORDER BY cost DESC, t.created_at ASC
    `
    return {
      period,
      items: rows.map((r) => {
        const usedTokens = r.input_tokens + r.output_tokens
        return {
          tenantId: r.tenant_id,
          name: r.name,
          plan: r.plan,
          status: r.status,
          quota: r.quota,
          inputTokens: Math.round(r.input_tokens),
          outputTokens: Math.round(r.output_tokens),
          usedTokens: Math.round(usedTokens),
          costCny: Number(r.cost.toFixed(4)),
          usedPct: r.quota ? Number(((usedTokens / r.quota) * 100).toFixed(1)) : 0,
          overLimit: usedTokens >= r.quota,
        }
      }),
    }
  }
}
