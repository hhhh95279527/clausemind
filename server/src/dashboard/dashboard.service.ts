// server/src/dashboard/dashboard.service.ts
// 企业合规仪表盘聚合（FR-15）：待办/审查用量/近 30 天风险/台账临期/Playbook 命中。
// 全部按 tenantId 隔离，控制查询条数、内存聚合，避免 N+1。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'

const SINCE_30D = () => new Date(Date.now() - 30 * 24 * 3600 * 1000)
const DAY_MS = 24 * 3600 * 1000

const LEDGER_TYPES: Record<string, string> = {
  FIXED_TERM_LABOR: '劳动合同',
  OPEN_ENDED_LABOR: '无固定期限劳动合同',
  SERVICE: '劳务合同',
  INTERNSHIP: '实习协议',
  NDA: '保密协议',
  NON_COMPETE: '竞业限制协议',
  OTHER: '其他合同',
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async summary(tenantId: string) {
    const since = SINCE_30D()
    const [plan, waitingCount, waitingTasks, failedContracts, riskSeverity, riskCategories, riskContracts,
      pbGroups, ledgerAll, ledgerTotal] = await Promise.all([
      this.entitlements.getEntitlementSnapshot(tenantId),
      this.db.reviewTask.count({ where: { tenantId, status: 'WAITING_REVIEW' } }),
      this.db.reviewTask.findMany({
        where: { tenantId, status: 'WAITING_REVIEW' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { contract: { select: { id: true, title: true } }, _count: { select: { risks: true } } },
      }),
      this.db.contract.findMany({
        where: { tenantId, status: 'FAILED' },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: { id: true, title: true, parseError: true, updatedAt: true },
      }),
      this.db.risk.groupBy({
        by: ['severity'],
        where: { contract: { tenantId }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.db.risk.groupBy({
        by: ['category'],
        where: { contract: { tenantId }, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.db.risk.groupBy({
        by: ['contractId'],
        where: { contract: { tenantId }, createdAt: { gte: since } },
      }),
      this.db.risk.groupBy({
        by: ['ruleId', 'reviewTaskId'],
        where: {
          contract: { tenantId }, detectedBy: 'PLAYBOOK', ruleId: { not: null },
          createdAt: { gte: since },
        },
      }),
      this.db.contractLedger.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: {
          id: true, employeeName: true, contractType: true, endDate: true, probationEnd: true,
        },
      }),
      this.db.contractLedger.count({ where: { tenantId } }),
    ])

    // 待办：待终审任务（含公司红线数）
    const waitingIds = waitingTasks.map((t) => t.id)
    const pbByTask = waitingIds.length
      ? await this.db.risk.groupBy({
        by: ['reviewTaskId'],
        where: { reviewTaskId: { in: waitingIds }, detectedBy: 'PLAYBOOK' },
        _count: { _all: true },
      })
      : []
    const pbTaskMap = new Map(pbByTask.map((g) => [g.reviewTaskId, g._count._all]))
    const todos = [
      ...waitingTasks.map((t) => ({
        kind: 'WAITING_REVIEW' as const,
        taskId: t.id,
        contractId: t.contract.id,
        title: t.contract.title,
        riskCount: t._count.risks,
        playbookCount: pbTaskMap.get(t.id) ?? 0,
        createdAt: t.createdAt,
      })),
      ...failedContracts.map((c) => ({
        kind: 'FAILED' as const,
        contractId: c.id,
        title: c.title,
        parseError: c.parseError,
        createdAt: c.updatedAt,
      })),
    ].slice(0, 6)

    // 近 30 天风险结构
    const sevMap = Object.fromEntries(riskSeverity.map((g) => [g.severity, g._count._all]))
    const risk30d = {
      high: sevMap.HIGH ?? 0,
      med: sevMap.MED ?? 0,
      low: sevMap.LOW ?? 0,
      total: riskSeverity.reduce((s, g) => s + g._count._all, 0),
      contracts: riskContracts.length,
    }
    const topCategories = riskCategories
      .map((g) => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // Playbook 命中 Top（按审查任务去重）
    const hitMap = new Map<string, Set<string>>()
    for (const g of pbGroups) {
      if (!g.ruleId) continue
      const set = hitMap.get(g.ruleId) ?? new Set<string>()
      set.add(g.reviewTaskId)
      hitMap.set(g.ruleId, set)
    }
    const ruleIds = [...hitMap.keys()]
    const rules = ruleIds.length
      ? await this.db.playbookRule.findMany({
        where: { id: { in: ruleIds }, tenantId },
        select: { id: true, title: true, description: true, kind: true, contractTypes: true },
      })
      : []
    const playbookHits = rules
      .map((r) => ({
        id: r.id, title: r.title, description: r.description, kind: r.kind,
        contractTypes: r.contractTypes, hits: hitMap.get(r.id)?.size ?? 0,
      }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5)

    // 台账到期：已过期 + 90 天内到期（含试用期到期），按紧急度排序
    const now = new Date()
    const deadlines = []
    for (const l of ledgerAll) {
      if (l.endDate) {
        const days = Math.round((l.endDate.getTime() - now.getTime()) / DAY_MS)
        if (days <= 90) {
          deadlines.push({
            ledgerId: l.id,
            name: l.employeeName,
            contractTypeLabel: LEDGER_TYPES[l.contractType] ?? l.contractType,
            date: l.endDate,
            days,
            bucket: days < 0 ? 'EXPIRED' : days <= 30 ? 'DUE_30' : 'DUE_90',
            kind: 'END' as const,
          })
        }
      }
      if (l.probationEnd) {
        const pdays = Math.round((l.probationEnd.getTime() - now.getTime()) / DAY_MS)
        if (pdays >= -30 && pdays <= 30) {
          deadlines.push({
            ledgerId: l.id,
            name: l.employeeName,
            contractTypeLabel: LEDGER_TYPES[l.contractType] ?? l.contractType,
            date: l.probationEnd,
            days: pdays,
            bucket: pdays < 0 ? 'PROBATION_DUE' : 'PROBATION_SOON',
            kind: 'PROBATION' as const,
          })
        }
      }
    }
    deadlines.sort((a, b) => a.date.getTime() - b.date.getTime())

    const expiredLedger = deadlines.filter((d) => d.bucket === 'EXPIRED').length
    const due30Ledger = deadlines.filter((d) => d.bucket === 'DUE_30').length

    return {
      plan,
      stats: {
        monthReviews: plan?.usedReviews ?? 0,
        reviewQuota: plan?.monthlyReviewQuota ?? null,
        pendingApproval: waitingCount,
        risk30d,
        ledgerTotal,
        ledgerMaxItems: plan?.ledgerMaxItems ?? null,
        due30Ledger,
        expiredLedger,
      },
      todos,
      topCategories,
      deadlines: deadlines.slice(0, 6),
      playbookHits,
    }
  }
}
