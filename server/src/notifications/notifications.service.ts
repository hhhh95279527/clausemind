// server/src/notifications/notifications.service.ts
// 站内通知（FR-22）：P0 全部实时计算、不落库——
// 台账到期 / 试用期到期 / 额度 80% / 额度用尽 / 免费存档清除预告 / 套餐到期。
// 每条查询与计算均显式限定 tenantId；个人空间跳过台账两类。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'

export type NotificationType =
  | 'LEDGER_EXPIRY'
  | 'PROBATION_EXPIRY'
  | 'QUOTA_80'
  | 'QUOTA_EXHAUSTED'
  | 'RETAIN_WARNING'
  | 'PLAN_EXPIRY'

export interface AppNotification {
  id: string
  type: NotificationType
  level: 'warning' | 'info' | 'danger'
  title: string
  desc: string
  actionUrl: string
  dueAt?: string
}

const DAY_MS = 24 * 3600 * 1000
const HOUR_MS = 3600 * 1000

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(tenantId: string): Promise<{ items: AppNotification[]; unread: number }> {
    const now = new Date()
    const [tenant, snapshot] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId } }),
      this.entitlements.getEntitlementSnapshot(tenantId),
    ])
    if (!tenant || !snapshot) return { items: [], unread: 0 }

    const isTeam = snapshot.workspaceType === 'TEAM'
    const items: AppNotification[] = []

    // ── ①② 台账/试用期到期（仅团队空间）──────────────────────
    if (isTeam) {
      // 日期窗口下推 SQL，避免拉全量 ACTIVE：
      // 合同到期取「未来 90 天内 + 任意已过期」(endDate ≤ now+90d)；
      // 试用期取未来 7 天。两者任一命中即需载入。
      const endHorizon = new Date(now.getTime() + 90 * DAY_MS)
      const probationHorizon = new Date(now.getTime() + 7 * DAY_MS)
      const ledgers = await this.db.contractLedger.findMany({
        where: {
          tenantId,
          status: 'ACTIVE',
          OR: [
            { endDate: { lte: endHorizon } },
            { probationEnd: { gte: now, lte: probationHorizon } },
          ],
        },
        select: {
          id: true, employeeName: true, endDate: true, probationEnd: true,
          remindBeforeDays: true,
        },
      })

      for (const l of ledgers) {
        // 合同到期：按每条记录的 remindBeforeDays 判定（含已过期）
        if (l.endDate) {
          const horizon = (l.remindBeforeDays ?? 30) * DAY_MS
          const ms = l.endDate.getTime() - now.getTime()
          if (ms <= horizon) {
            const days = Math.round(ms / DAY_MS)
            const overdue = days < 0
            items.push({
              id: `ledger:${l.id}`,
              type: 'LEDGER_EXPIRY',
              level: overdue || days <= 7 ? 'danger' : 'warning',
              title: overdue
                ? `${l.employeeName} 的合同已到期`
                : `${l.employeeName} 的合同 ${days === 0 ? '今日到期' : `${days} 天后到期`}`,
              desc: overdue
                ? `已超过到期日 ${Math.abs(days)} 天，请及时续签或办理解除`
                : '请在到期前完成续签或解除安排',
              actionUrl: '/ledger',
              dueAt: l.endDate.toISOString(),
            })
          }
        }

        // 试用期到期：未来 7 天内
        if (l.probationEnd) {
          const pms = l.probationEnd.getTime() - now.getTime()
          const pdays = Math.round(pms / DAY_MS)
          if (pms >= 0 && pdays <= 7) {
            items.push({
              id: `probation:${l.id}`,
              type: 'PROBATION_EXPIRY',
              level: pdays <= 3 ? 'warning' : 'info',
              title: `${l.employeeName} 的试用期 ${pdays === 0 ? '今日届满' : `${pdays} 天后届满`}`,
              desc: '请及时安排转正评估或试用期考核',
              actionUrl: '/ledger',
              dueAt: l.probationEnd.toISOString(),
            })
          }
        }
      }
    }

    // ── ③④ 月度审查额度 ─────────────────────────────────────
    const quota = snapshot.monthlyReviewQuota
    if (quota !== null) {
      const used = snapshot.usedReviews
      if (used >= quota) {
        items.push({
          id: 'quota:exhausted',
          type: 'QUOTA_EXHAUSTED',
          level: 'danger',
          title: `本月免费审查 ${used}/${quota} 份已用尽`,
          desc: '升级个人版后订阅期不限份数，也可购买深度审查券 ¥9.9/份',
          actionUrl: '/me/billing',
        })
      } else if (used / quota >= 0.8) {
        items.push({
          id: 'quota:80',
          type: 'QUOTA_80',
          level: 'warning',
          title: `本月免费审查已用 ${used}/${quota} 份`,
          desc: '额度即将用尽，升级后订阅期不限份数',
          actionUrl: '/me/billing',
        })
      }
    }

    // ── ⑤ 免费存档清除预告（FREE，未来 24h 内到期）─────────────
    if (snapshot.plan === 'FREE') {
      const contracts = await this.db.contract.findMany({
        where: {
          tenantId,
          retainUntil: { lte: new Date(now.getTime() + 24 * HOUR_MS) },
        },
        orderBy: { retainUntil: 'asc' },
        select: { id: true, title: true, retainUntil: true },
        take: 50,
      })
      const pending = contracts.filter((c) => c.retainUntil && c.retainUntil.getTime() >= now.getTime())
      pending.slice(0, 3).forEach((c) => {
        const hours = Math.max(0, Math.round((c.retainUntil.getTime() - now.getTime()) / HOUR_MS))
        items.push({
          id: `retain:${c.id}`,
          type: 'RETAIN_WARNING',
          level: 'warning',
          title: `《${c.title}》即将被自动清除`,
          desc: hours === 0
            ? '免费审查记录已到 7 天保留期限，即将清除'
            : `剩余约 ${hours} 小时，升级个人版可永久存档`,
          actionUrl: `/review/${c.id}`,
          dueAt: c.retainUntil.toISOString(),
        })
      })
      if (pending.length > 3) {
        items.push({
          id: 'retain:more',
          type: 'RETAIN_WARNING',
          level: 'info',
          title: `另有 ${pending.length - 3} 份免费记录即将清除`,
          desc: '升级个人版后全部记录永久保留',
          actionUrl: '/my-contracts',
        })
      }
    }

    // ── ⑥ 套餐到期（未来 7 天内）──────────────────────────────
    if (snapshot.planExpiresAt) {
      const ms = snapshot.planExpiresAt.getTime() - now.getTime()
      const days = Math.round(ms / DAY_MS)
      if (ms >= 0 && days <= 7) {
        const isTeamSpace = snapshot.workspaceType === 'TEAM'
        items.push({
          id: 'plan:expiry',
          type: 'PLAN_EXPIRY',
          level: snapshot.cancelAtPeriodEnd ? 'warning' : 'info',
          title: snapshot.cancelAtPeriodEnd
            ? `套餐将于 ${days === 0 ? '今日' : `${days} 天后`}到期，到期后降级免费版`
            : `套餐将于 ${days === 0 ? '今日' : `${days} 天后`}到期`,
          desc: snapshot.cancelAtPeriodEnd
            ? '可撤回取消或续费，继续使用完整权益'
            : '续费后继续使用完整权益',
          actionUrl: isTeamSpace ? '/billing' : '/me/billing',
          dueAt: snapshot.planExpiresAt.toISOString(),
        })
      }
    }

    // danger → warning → info，同级按到期时间
    const levelOrder = { danger: 0, warning: 1, info: 2 }
    items.sort((a, b) => {
      const lv = levelOrder[a.level] - levelOrder[b.level]
      if (lv !== 0) return lv
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity
      return ta - tb
    })
    return { items, unread: items.length }
  }
}
