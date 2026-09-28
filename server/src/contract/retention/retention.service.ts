// server/src/contract/retention/retention.service.ts
// 免费档记录 TTL（FR-10）：每日 03:17 删除 retainUntil 已过期的 FREE 租户合同。
// - 升级后保留：只删当前 plan=FREE 的租户合同，升级后旧记录不再被清
// - 级联由外键 onDelete=Cascade 处理（clauses/risks/review_tasks）
// - P0 不做通知持久化（Phase 7 铃铛实时计算到期预告）
import { Injectable, OnModuleInit } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service.js'
import { QueueService, QUEUES } from '../../queue/queue.service.js'
import { logger } from '../../utils/logger.js'

@Injectable()
export class RetentionService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: QueueService,
  ) {}

  onModuleInit() {
    this.queue.processor(QUEUES.RETENTION_CLEANUP, () => this.cleanupExpired())
    this.queue.repeatable(QUEUES.RETENTION_CLEANUP, '17 3 * * *', 'Asia/Shanghai')
  }

  /** 清理过期 FREE 合同，返回删除条数 */
  async cleanupExpired(now = new Date()): Promise<number> {
    const freeTenants = await this.db.tenant.findMany({
      where: { plan: 'FREE' },
      select: { id: true },
    })
    if (!freeTenants.length) return 0

    const result = await this.db.contract.deleteMany({
      where: {
        retainUntil: { lt: now },
        tenantId: { in: freeTenants.map((t) => t.id) },
      },
    })
    if (result.count > 0) {
      logger.info('retention: expired FREE contracts removed', { count: result.count })
    }
    return result.count
  }
}
