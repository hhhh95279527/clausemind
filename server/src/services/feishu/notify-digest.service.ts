// server/src/services/feishu/notify-digest.service.ts
// 每日 09:00（Asia/Shanghai）digest：把站内通知中的到期/清除类提醒汇总成群消息，
// 并行推送到飞书 / 钉钉 / 企业微信（租户配了哪个推哪个，均未配置则静默）。
// 空内容不发；逐租户 try/catch 隔离，任何失败不影响其他租户。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service.js'
import { QueueService, QUEUES } from '../../queue/queue.service.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { FeishuNotifyService, buildInteractiveCard } from './feishu-notify.service.js'
import { DingtalkNotifyService } from '../dingtalk/dingtalk-notify.service.js'
import { WeworkNotifyService } from '../wework/wework-notify.service.js'
import { logger } from '../../utils/logger.js'

const DIGEST_TYPES = new Set(['LEDGER_EXPIRY', 'PROBATION_EXPIRY', 'RETAIN_WARNING'])
const MAX_LINES = 20

@Injectable()
export class NotifyDigestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    private readonly feishu: FeishuNotifyService,
    private readonly dingtalk: DingtalkNotifyService,
    private readonly wework: WeworkNotifyService,
  ) {}

  onModuleInit() {
    this.queue.processor(QUEUES.DAILY_DIGEST, () => this.runDigest())
    this.queue.repeatable(QUEUES.DAILY_DIGEST, '0 9 * * *', 'Asia/Shanghai')
  }

  async runDigest(): Promise<number> {
    const tenants = await this.db.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    })
    let sent = 0
    for (const t of tenants) {
      try {
        const result = await this.sendTenantDigest(t.id)
        if (result.ok) sent += 1
      } catch (err) {
        logger.error('digest: tenant failed', { tenantId: t.id, error: (err as Error).message })
      }
    }
    logger.info('daily digest finished', { tenants: tenants.length, sent })
    return sent
  }

  async sendTenantDigest(tenantId: string) {
    const { items } = await this.notifications.list(tenantId)
    const picked = items.filter((i) => DIGEST_TYPES.has(i.type))
    if (!picked.length) return { ok: false, reason: 'empty' }

    const shown = picked.slice(0, MAX_LINES)
    const lines = shown.map((i) => {
      const icon = i.level === 'danger' ? '🔴' : i.level === 'warning' ? '🟡' : '🔵'
      return `${icon} **${i.title}**\n　${i.desc}`
    })
    if (picked.length > MAX_LINES) {
      lines.push(`……另有 ${picked.length - MAX_LINES} 条，登录 ClauseMind 查看全部`)
    }

    const title = `ClauseMind 每日提醒 · ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')}`
    // 三通道并行推送；任一通道失败/未配置不影响其他通道
    const results = await Promise.all([
      this.feishu.sendCard(tenantId, buildInteractiveCard({ template: 'blue', title, lines })),
      this.dingtalk.sendMarkdown(tenantId, title, lines),
      this.wework.sendMarkdown(tenantId, title, lines),
    ])
    const delivered = results.filter((r) => r.ok).length
    return { ok: delivered > 0, reason: delivered ? undefined : results.map((r) => r.reason).join(',') }
  }
}
