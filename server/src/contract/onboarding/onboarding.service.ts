// server/src/contract/onboarding/onboarding.service.ts
// 新手引导（FR-3）：
// - 「体验示例合同」复制为租户名下文本合同并入解析队列；每租户限一次、不扣审查额度；
// - FREE 空间按 7 天保留置 retainUntil（FR-11：示例合同同规则），付费空间永久保留；
// - 幂等标记落 analytics_events（即使示例合同被删除，也不能再领第二次）。
import { ConflictException, Injectable } from '@nestjs/common'
import fs from 'fs/promises'
import { DatabaseService } from '../../database/database.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { ContractParseService } from '../parsing/contract-parse.service.js'
import { logger } from '../../utils/logger.js'
import {
  SAMPLE_CONTRACT_TEXT,
  SAMPLE_CONTRACT_TITLE,
  SAMPLE_CONTRACT_FILENAME,
} from './sample-contract.data.js'

const SAMPLE_EVENT_TYPE = 'onboarding_sample_copied'
const FREE_RETENTION_DAYS = 7

interface Actor {
  userId: string
  tenantId: string
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly parseService: ContractParseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** 本租户是否已领取过示例合同（空状态双 CTA 用） */
  async hasSampleContract(tenantId: string): Promise<boolean> {
    const count = await this.db.analyticsEvent.count({
      where: { tenantId, type: SAMPLE_EVENT_TYPE },
    })
    return count > 0
  }

  /**
   * 复制示例合同到当前租户：写临时 txt → 建合同（置 retainUntil）→ 入解析队列。
   * 不创建审查任务、不扣月度额度；是否审查、何时审查由用户决定。
   */
  async copySampleContract(actor: Actor) {
    const { tenantId, userId } = actor

    const already = await this.hasSampleContract(tenantId)
    if (already) {
      throw new ConflictException('示例合同每个空间仅可体验一次')
    }

    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    // 付费空间（PERSONAL 及以上）永久保留；FREE 置 7 天后到期，由 TTL 任务清理
    const retainUntil = this.entitlements.isDeep(tenant.plan)
      ? null
      : new Date(Date.now() + FREE_RETENTION_DAYS * 24 * 60 * 60 * 1000)

    await fs.mkdir('./uploads', { recursive: true })
    const tmpPath = `./uploads/sample_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
    await fs.writeFile(tmpPath, SAMPLE_CONTRACT_TEXT, 'utf-8')

    const contract = await this.db.contract.create({
      data: {
        tenantId,
        uploadedBy: userId,
        title: SAMPLE_CONTRACT_TITLE,
        fileName: SAMPLE_CONTRACT_FILENAME,
        fileType: 'txt',
        status: 'UPLOADED',
        retainUntil,
      },
    })

    await this.parseService.enqueue(contract.id, tmpPath)

    // 幂等标记：与合同创建分开记录，删除合同也不允许二次领取
    await this.db.analyticsEvent.create({
      data: {
        tenantId,
        userId,
        type: SAMPLE_EVENT_TYPE,
        props: { contractId: contract.id, source: 'onboarding' },
      },
    })

    logger.info('onboarding: sample contract copied', {
      tenantId, userId, contractId: contract.id, retainUntil,
    })

    return { contract, retainUntil }
  }
}
