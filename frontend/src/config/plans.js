// frontend/src/config/plans.js
// 套餐权益【展示镜像】，唯一事实源在后端 server/src/billing/plans.config.ts
// 改价格/权益时两边同步；运行时真实判定以后端 /api 返回为准，本文件仅用于静态展示与付费墙。

// 价格单位：元（后端存分）
// 当前定价：所有套餐统一 ¥0.01（测试价）
export const PRICES = {
  PERSONAL_MONTHLY: 0.01,
  PERSONAL_YEARLY: 0.01,
  TEAM_PER_SEAT_MONTHLY: 0.01,
  COUPON_UNIT: 0.01,
  COUPON_PACK_QTY: 10,
  COUPON_PACK: 0.01,
}

export const FREE_LIMITS = {
  monthlyReviews: 2,
  maxChars: 3000,
  retentionDays: 7,
  ledgerMaxItems: 10,
  // 免费可审五类个人高频场景（买卖/借款/股权及非标合同付费）
  allowedScenes: ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA'],
}


