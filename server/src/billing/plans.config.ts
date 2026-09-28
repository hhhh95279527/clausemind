// server/src/billing/plans.config.ts
// 套餐权益单一事实源：四档套餐的价格 / 额度 / 能力 / 存档 / 协作集成（FR-12）
// 前端镜像见 frontend/src/config/plans.js，两者必须同步；价格单位：分（人民币）。
// 价格为配置常量，调整仅改本文件。

export type PlanCode = 'FREE' | 'PERSONAL' | 'TEAM' | 'ENTERPRISE'
export type WorkspaceKind = 'PERSONAL' | 'TEAM'

/** 审查场景类型：FREE 仅前四类，非标合同仅付费套餐 */
export type ReviewScene = 'LABOR' | 'LEASE' | 'SERVICE' | 'NDA' | 'CUSTOM'

/** PLAN_LIMIT 拦截原因（与前端付费墙 reason 对齐） */
export type PlanLimitReason =
  | 'MONTHLY_QUOTA'    // 免费月度份数用尽
  | 'CHAR_LIMIT'       // 超字数
  | 'CONTRACT_TYPE'    // 非标类型
  | 'DEEP_FEATURE'     // 深度能力（Agent 轨/法条/建议/替代措辞/多轮/改稿）
  | 'EXPORT'           // Word/无水印导出、范本下载
  | 'LEDGER_LIMIT'     // 台账超 10 条
  | 'PLAYBOOK'         // Playbook 仅企业空间
  | 'TEAM_SPACE'       // 团队/集成页仅企业空间
  | 'SEAT_LIMIT'       // 超席位
  | 'COUPON_REQUIRED'  // 需要深度券

/** 权益特性名（EntitlementsService.can 判定用） */
export type Feature =
  | 'deep'              // 深度能力总开关：Agent 轨/法条依据/修改建议/替代措辞/多轮追问/AI 改稿
  | 'playbook'          // 企业自定义规则
  | 'wordExport'        // Word 红划线/全文导出
  | 'pdfFullExport'     // 无水印 PDF 全文
  | 'permanentStorage'  // 永久存档
  | 'clauseLibrary'     // 个人条款库/关注偏好
  | 'ledgerUnlimited'   // 台账不限条数
  | 'teamCollaboration'// 团队席位/协作
  | 'feishu'            // 飞书集成
  | 'ocr'               // 图片 OCR 审查
  | 'longDocument'      // 长文档/非标合同
  | 'batchReview'       // 批量审查（P1）

/** 单档套餐定义 */
export interface PlanDef {
  code: PlanCode
  /** 工作空间归属：PERSONAL 曲线 / TEAM 曲线 */
  workspace: WorkspaceKind
  label: string
  /** 月付价（分）；0=免费；null=定制询价 */
  priceMonthlyFen: number | null
  /** 年付价（分）；null=不支持/定制 */
  priceYearlyFen: number | null
  /** 席位数：Infinity=不限 */
  seats: number
  /** 每月免费审查份数：Infinity=订阅期不限 */
  monthlyReviewQuota: number
  /** 单份合同字数上限：Infinity=不限 */
  maxChars: number
  /** 可审查场景类型 */
  allowedScenes: ReviewScene[]
  /** 免费记录保留天数；null=永久 */
  retentionDays: number | null
  /** 台账条数上限；Infinity=不限 */
  ledgerMaxItems: number
  /** 特性开关 */
  features: Record<Feature, boolean>
  /** 是否支持深度券跨档解锁单份 */
  couponSupported: boolean
}

const ALL_SCENES: ReviewScene[] = ['LABOR', 'LEASE', 'SERVICE', 'NDA', 'CUSTOM']
const FREE_SCENES: ReviewScene[] = ['LABOR', 'LEASE', 'SERVICE', 'NDA']

export const PLAN_DEFS: Record<PlanCode, PlanDef> = {
  FREE: {
    code: 'FREE',
    workspace: 'PERSONAL',
    label: '免费版',
    priceMonthlyFen: 0,
    priceYearlyFen: 0,
    seats: 1,
    monthlyReviewQuota: 2,
    maxChars: 3000,
    allowedScenes: FREE_SCENES,
    retentionDays: 7,
    ledgerMaxItems: 10,
    couponSupported: true,
    features: {
      deep: false,
      playbook: false,
      wordExport: false,
      pdfFullExport: false,
      permanentStorage: false,
      clauseLibrary: false,
      ledgerUnlimited: false,
      teamCollaboration: false,
      feishu: false,
      ocr: true,
      longDocument: false,
      batchReview: false,
    },
  },
  PERSONAL: {
    code: 'PERSONAL',
    workspace: 'PERSONAL',
    label: '个人版',
    priceMonthlyFen: 1900,   // ¥19/月
    priceYearlyFen: 9900,    // ¥99/年（省 48%）
    seats: 1,
    monthlyReviewQuota: Infinity,
    maxChars: Infinity,
    allowedScenes: ALL_SCENES,
    retentionDays: null,
    ledgerMaxItems: 10,
    couponSupported: true,
    features: {
      deep: true,
      playbook: false,
      wordExport: true,
      pdfFullExport: true,
      permanentStorage: true,
      clauseLibrary: true,
      ledgerUnlimited: false,
      teamCollaboration: false,
      feishu: false,
      ocr: true,
      longDocument: true,
      batchReview: false,
    },
  },
  TEAM: {
    code: 'TEAM',
    workspace: 'TEAM',
    label: '团队版',
    priceMonthlyFen: 9900,   // ¥99/席/月
    priceYearlyFen: null,
    seats: 5,
    monthlyReviewQuota: Infinity,
    maxChars: Infinity,
    allowedScenes: ALL_SCENES,
    retentionDays: null,
    ledgerMaxItems: Infinity,
    couponSupported: true,
    features: {
      deep: true,
      playbook: true,
      wordExport: true,
      pdfFullExport: true,
      permanentStorage: true,
      clauseLibrary: true,
      ledgerUnlimited: true,
      teamCollaboration: true,
      feishu: true,
      ocr: true,
      longDocument: true,
      batchReview: false,    // P1
    },
  },
  ENTERPRISE: {
    code: 'ENTERPRISE',
    workspace: 'TEAM',
    label: '企业版',
    priceMonthlyFen: null,   // 定制询价
    priceYearlyFen: null,
    seats: Infinity,
    monthlyReviewQuota: Infinity,
    maxChars: Infinity,
    allowedScenes: ALL_SCENES,
    retentionDays: null,
    ledgerMaxItems: Infinity,
    couponSupported: false,
    features: {
      deep: true,
      playbook: true,
      wordExport: true,
      pdfFullExport: true,
      permanentStorage: true,
      clauseLibrary: true,
      ledgerUnlimited: true,
      teamCollaboration: true,
      feishu: true,
      ocr: true,
      longDocument: true,
      batchReview: false,
    },
  },
}

// ── 深度券（跨档，1 券解锁 1 份完整深度审查，不计入月额度）────────
export const COUPON_UNIT_PRICE_FEN = 990          // ¥9.9/份
export const COUPON_PACK_QTY = 10                 // 10 张/包
export const COUPON_PACK_PRICE_FEN = 9900         // ¥99/包（10 张）

// ── 收银台商品目录（FR-13：价格为配置常量，禁止客户端传价）─────────
export type CheckoutItem =
  | 'PERSONAL_MONTHLY'
  | 'PERSONAL_YEARLY'
  | 'COUPON_PACK'
  | 'TEAM_MONTHLY'

export interface CheckoutItemDef {
  item: CheckoutItem
  /** 对应 Order.kind */
  kind: 'SUBSCRIPTION' | 'COUPON_PACK' | 'UPGRADE'
  /** Order.period（券包为 NONE） */
  period: 'MONTH' | 'YEAR' | 'NONE'
  targetPlan: PlanCode | null
  couponQty: number | null
  amountFen: number
}

export const CHECKOUT_ITEMS: Record<CheckoutItem, CheckoutItemDef> = {
  PERSONAL_MONTHLY: {
    item: 'PERSONAL_MONTHLY', kind: 'SUBSCRIPTION', period: 'MONTH',
    targetPlan: 'PERSONAL', couponQty: null, amountFen: PLAN_DEFS.PERSONAL.priceMonthlyFen!,
  },
  PERSONAL_YEARLY: {
    item: 'PERSONAL_YEARLY', kind: 'SUBSCRIPTION', period: 'YEAR',
    targetPlan: 'PERSONAL', couponQty: null, amountFen: PLAN_DEFS.PERSONAL.priceYearlyFen!,
  },
  COUPON_PACK: {
    item: 'COUPON_PACK', kind: 'COUPON_PACK', period: 'NONE',
    targetPlan: null, couponQty: COUPON_PACK_QTY, amountFen: COUPON_PACK_PRICE_FEN,
  },
  TEAM_MONTHLY: {
    item: 'TEAM_MONTHLY', kind: 'UPGRADE', period: 'MONTH',
    targetPlan: 'TEAM', couponQty: null, amountFen: PLAN_DEFS.TEAM.priceMonthlyFen!,
  },
}

export function getCheckoutItem(item: string): CheckoutItemDef | null {
  return CHECKOUT_ITEMS[item as CheckoutItem] ?? null
}

// ── 免费档存档 TTL ──────────────────────────────────────────────────────────
export const FREE_RETENTION_DAYS = 7
/** 删除前 1 天进通知铃铛 */
export const FREE_RETENTION_WARN_HOURS = 24

export function getPlanDef(plan: string): PlanDef {
  return PLAN_DEFS[(plan as PlanCode)] ?? PLAN_DEFS.FREE
}

/** 是否深度付费档（PERSONAL 及以上） */
export function isDeepPlan(plan: string): boolean {
  return getPlanDef(plan).features.deep
}

/** 是否企业空间档（TEAM/ENTERPRISE） */
export function isTeamWorkspace(plan: string): boolean {
  return getPlanDef(plan).workspace === 'TEAM'
}
