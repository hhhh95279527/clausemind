// server/src/billing/trial.service.ts
// 试用计量：非演示 FREE 租户每项 AI 功能终身免费 2 次，用完抛 TRIAL_EXHAUSTED 付费墙。
// - 演示租户（按租户名匹配，config.trial.demoTenantNames）与付费档完全不受限
// - 按租户计（套餐是租户级），同租户共享次数
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { config } from '../config/index.js'
import { PlanLimitException } from './plan-limit.exception.js'

/** 试用功能维度 */
export type TrialFeature = 'REVIEW' | 'CHAT' | 'DRAFT' | 'EXPORT'

const FEATURE_LABEL: Record<TrialFeature, string> = {
  REVIEW: '合同审查',
  CHAT: 'AI 问答',
  DRAFT: 'AI 改稿',
  EXPORT: '报告导出',
}

@Injectable()
export class TrialService {
  constructor(private readonly db: DatabaseService) {}

  /** 免计费：演示租户（测试科技/个人演示空间）或非 FREE 付费档；不存在的租户不豁免 */
  private async exempt(tenantId: string): Promise<boolean> {
    const tenant = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, plan: true },
    })
    return !!tenant
      && (config.trial.demoTenantNames.includes(tenant.name) || tenant.plan !== 'FREE')
  }

  /** 断言试用次数未用尽（FREE 非演示租户；其余放行） */
  async assertTrialAvailable(tenantId: string, feature: TrialFeature): Promise<void> {
    if (await this.exempt(tenantId)) return
    const row = await this.db.trialUsage.findUnique({
      where: { tenantId_feature: { tenantId, feature } },
    })
    if ((row?.usedCount ?? 0) >= config.trial.freeLimit) {
      throw new PlanLimitException(
        'TRIAL_EXHAUSTED',
        `免费试用已结束：${FEATURE_LABEL[feature]}共可免费体验 ${config.trial.freeLimit} 次，升级套餐后不限使用`,
        'trial',
      )
    }
  }

  /** 消耗一次试用（发起即计；免计费对象自动跳过） */
  async consumeTrial(tenantId: string, feature: TrialFeature): Promise<void> {
    if (await this.exempt(tenantId)) return
    await this.db.trialUsage.upsert({
      where: { tenantId_feature: { tenantId, feature } },
      create: { tenantId, feature, usedCount: 1 },
      update: { usedCount: { increment: 1 } },
    })
  }

  /** 试用状态快照（我的套餐页额度卡展示） */
  async getTrialSnapshot(tenantId: string) {
    if (await this.exempt(tenantId)) return null
    const rows = await this.db.trialUsage.findMany({ where: { tenantId } })
    const byFeature = Object.fromEntries(
      rows.map((r) => [r.feature, r.usedCount]),
    ) as Record<TrialFeature, number>
    return {
      freeLimit: config.trial.freeLimit,
      used: {
        REVIEW: byFeature.REVIEW ?? 0,
        CHAT: byFeature.CHAT ?? 0,
        DRAFT: byFeature.DRAFT ?? 0,
        EXPORT: byFeature.EXPORT ?? 0,
      },
    }
  }
}
