// server/src/billing/subscription-lifecycle.service.ts
// 订阅生命周期（FR-13 降级）：每日 03:41 扫描已过 planExpiresAt 的付费租户，降级为 FREE。
// - 取消订阅不立即生效：权益保留至到期日（二次确认时已明确提示）
// - 超额数据只读不删：不动合同/条款库/订单；仅改套餐字段与工作空间类型
// - 深度券保留：券包与订阅无关，降级不清券
import { Injectable, OnModuleInit } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { QueueService, QUEUES } from '../queue/queue.service.js'
import { logger } from '../utils/logger.js'

@Injectable()
export class SubscriptionLifecycleService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    this.queue.processor(QUEUES.SUBSCRIPTION_EXPIRY, () => this.expireDuePlans())
    this.queue.repeatable(QUEUES.SUBSCRIPTION_EXPIRY, '41 3 * * *', 'Asia/Shanghai')
  }

  /** 将已到期的付费套餐降级 FREE，返回处理租户数 */
  async expireDuePlans(now = new Date()): Promise<number> {
    const due = await this.db.tenant.findMany({
      where: {
        plan: { not: 'FREE' },
        planExpiresAt: { not: null, lt: now },
      },
      select: { id: true, plan: true, workspaceType: true, planExpiresAt: true },
    })
    if (!due.length) return 0

    for (const t of due) {
      await this.db.tenant.update({
        where: { id: t.id },
        data: {
          plan: 'FREE',
          workspaceType: 'PERSONAL',
          cancelAtPeriodEnd: false,
          planUpdatedAt: now,
        },
      })
      await this.audit.log({
        tenantId: t.id,
        action: 'SUBSCRIPTION_EXPIRED_DOWNGRADE',
        resource: 'tenant',
        resourceId: t.id,
        detail: {
          previousPlan: t.plan,
          previousWorkspace: t.workspaceType,
          planExpiresAt: t.planExpiresAt?.toISOString(),
        },
      })
      logger.info('subscription expired: tenant downgraded to FREE', {
        tenantId: t.id, previousPlan: t.plan,
      })
    }
    return due.length
  }
}
