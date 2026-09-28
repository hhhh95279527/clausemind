// server/src/billing/entitlements.service.ts
// 权益判定与计量统一入口（FR-12）。所有套餐拦截必须走本服务，禁止业务代码自行 if plan。
// - 纯权益判定：can / assertFeature（配置事实源 plans.config.ts）
// - 计量判定：月度审查份数、台账条数、团队席位（查库，显式 tenantId）
// - 拦截失败统一抛 PlanLimitException → 403 PLAN_LIMIT
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import {
  getPlanDef,
  isDeepPlan,
  isTeamWorkspace,
  type Feature,
  type PlanCode,
  type PlanLimitReason,
  type ReviewScene,
} from './plans.config.js'
import { PlanLimitException } from './plan-limit.exception.js'
import { currentPeriod } from '../observability/quota.service.js'

/** 发起审查入参 */
export interface StartReviewInput {
  charCount: number
  scene: ReviewScene
  /** 用深度券抵扣：跳过月额度/字数/类型限制，放行 Agent 深度轨（券扣减在审查创建事务中完成） */
  payWithCoupon?: boolean
}

@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  // ── 纯配置判定（不查库）──────────────────────────────────────────────────

  /** 套餐是否含某特性 */
  can(plan: string, feature: Feature): boolean {
    return getPlanDef(plan).features[feature]
  }

  /** 断言套餐含某特性，否则 PLAN_LIMIT */
  assertFeature(plan: string, feature: Feature, reason: PlanLimitReason = 'DEEP_FEATURE'): void {
    if (!this.can(plan, feature)) {
      throw new PlanLimitException(reason, this.featureMessage(reason), feature)
    }
  }

  /** 是否深度档（PERSONAL+，Agent 轨/改稿等） */
  isDeep(plan: string): boolean {
    return isDeepPlan(plan)
  }

  /** 是否企业空间档（TEAM/ENTERPRISE） */
  isTeam(plan: string): boolean {
    return isTeamWorkspace(plan)
  }

  getPlan(plan: string) {
    return getPlanDef(plan)
  }

  // ── 审查发起拦截（FR-12 拦截点①：额度/字数/非标类型）─────────────────────

  /**
   * 断言当前租户可发起审查。
   * - 用券：仅校验券余额 > 0（调用方需在审查创建事务中原子扣减）
   * - 不用券：月度份数 → 字数 → 场景类型 顺序校验
   * 返回本次是否走深度轨（用券或深度套餐）。
   */
  async assertStartReview(tenantId: string, input: StartReviewInput): Promise<{ deep: boolean }> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new PlanLimitException('DEEP_FEATURE', '工作空间不存在', 'tenant')

    // 深度券通道：1 券 = 1 份完整深度（含长文档/非标），不占月额度
    if (input.payWithCoupon) {
      if (tenant.couponBalance <= 0) {
        throw new PlanLimitException('COUPON_REQUIRED', '深度券余额不足，请购买或订阅', 'coupon')
      }
      return { deep: true }
    }

    const def = getPlanDef(tenant.plan)

    // ① 月度份数
    if (def.monthlyReviewQuota !== Infinity) {
      const used = await this.countMonthlyReviews(tenantId)
      if (used >= def.monthlyReviewQuota) {
        throw new PlanLimitException(
          'MONTHLY_QUOTA',
          `免费版每月 ${def.monthlyReviewQuota} 份审查已用尽，升级后订阅期不限份数`,
          'review.monthlyQuota',
        )
      }
    }

    // ② 字数
    if (def.maxChars !== Infinity && input.charCount > def.maxChars) {
      throw new PlanLimitException(
        'CHAR_LIMIT',
        `免费版单份合同限 ${def.maxChars} 字以内，当前 ${input.charCount} 字，升级或用深度券可审长文档`,
        'review.maxChars',
      )
    }

    // ③ 场景类型
    if (!def.allowedScenes.includes(input.scene)) {
      throw new PlanLimitException(
        'CONTRACT_TYPE',
        '免费版仅支持劳动 / 租赁 / 劳务 / NDA 四类合同，非标合同请升级或用深度券',
        'review.scene',
      )
    }

    return { deep: def.features.deep }
  }

  /**
   * 断言深度能力可用（FR-12 拦截点②：Agent 轨/折叠区/多轮/改稿台）。
   * 业务侧在已持有 couponPass 标记（本次审查用券解锁）时直接放行。
   */
  assertDeepAccess(plan: string, couponPass = false): void {
    if (couponPass || isDeepPlan(plan)) return
    throw new PlanLimitException('DEEP_FEATURE', '深度建议 / 法条依据 / AI 改稿为付费能力', 'deep')
  }

  // ── 台账拦截（FR-12 拦截点④）─────────────────────────────────────────────

  async assertLedgerCreate(tenantId: string): Promise<void> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new PlanLimitException('LEDGER_LIMIT', '工作空间不存在', 'tenant')
    const def = getPlanDef(tenant.plan)
    if (def.ledgerMaxItems === Infinity) return
    const count = await this.db.contractLedger.count({ where: { tenantId } })
    if (count >= def.ledgerMaxItems) {
      throw new PlanLimitException(
        'LEDGER_LIMIT',
        `免费/个人版台账最多 ${def.ledgerMaxItems} 条，团队版不限条数`,
        'ledger',
      )
    }
  }

  // ── 企业空间拦截（FR-12 拦截点⑤：Playbook/团队/集成）─────────────────────

  assertTeamSpace(plan: string): void {
    if (isTeamWorkspace(plan)) return
    throw new PlanLimitException('TEAM_SPACE', '该功能为团队空间能力，请创建/升级团队', 'team')
  }

  // ── 席位拦截（FR-18）──────────────────────────────────────────────────────

  async assertSeatAvailable(tenantId: string): Promise<{ seats: number; members: number }> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new PlanLimitException('SEAT_LIMIT', '工作空间不存在', 'tenant')
    const def = getPlanDef(tenant.plan)
    const members = await this.db.user.count({ where: { tenantId, status: { not: 'DISABLED' } } })
    if (def.seats !== Infinity && members >= def.seats) {
      throw new PlanLimitException(
        'SEAT_LIMIT',
        `团队版含 ${def.seats} 席，当前已用 ${members} 席，请增购席位`,
        'team.seats',
      )
    }
    return { seats: def.seats, members }
  }

  // ── 计量查询 ──────────────────────────────────────────────────────────────

  /** 当月已发起审查次数（按 review_tasks 创建计，重审重新计） */
  async countMonthlyReviews(tenantId: string): Promise<number> {
    const period = currentPeriod()
    const monthStart = new Date(
      Date.UTC(
        Number(period.slice(0, 4)),
        Number(period.slice(5, 7)) - 1,
        1,
      ) - 8 * 3600_000, // 北京账期 1 号 00:00 → UTC
    )
    return this.db.reviewTask.count({
      where: { tenantId, createdAt: { gte: monthStart } },
    })
  }

  /** 套餐快照（前端额度卡 / 权益页 / 收银台回跳） */
  async getEntitlementSnapshot(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) return null
    const def = getPlanDef(tenant.plan)
    const usedReviews = await this.countMonthlyReviews(tenantId)
    const usedSeats = await this.db.user.count({
      where: { tenantId, status: { not: 'DISABLED' } },
    })
    return {
      plan: def.code as PlanCode,
      workspaceType: tenant.workspaceType,
      label: def.label,
      couponBalance: tenant.couponBalance,
      planExpiresAt: tenant.planExpiresAt,
      cancelAtPeriodEnd: tenant.cancelAtPeriodEnd,
      seats: def.seats === Infinity ? null : def.seats,
      usedSeats,
      monthlyReviewQuota: def.monthlyReviewQuota === Infinity ? null : def.monthlyReviewQuota,
      usedReviews,
      maxChars: def.maxChars === Infinity ? null : def.maxChars,
      ledgerMaxItems: def.ledgerMaxItems === Infinity ? null : def.ledgerMaxItems,
      retentionDays: def.retentionDays,
      features: def.features,
    }
  }

  private featureMessage(reason: PlanLimitReason): string {
    switch (reason) {
      case 'PLAYBOOK':    return 'Playbook 自定义规则为团队版能力'
      case 'EXPORT':      return 'Word 红划线 / 无水印导出为付费能力'
      case 'TEAM_SPACE':  return '该功能为团队空间能力，请创建/升级团队'
      default:            return '该能力为付费功能，请升级套餐或使用深度券'
    }
  }
}
