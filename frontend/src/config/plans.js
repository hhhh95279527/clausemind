// frontend/src/config/plans.js
// 套餐权益【展示镜像】，唯一事实源在后端 server/src/billing/plans.config.ts
// 改价格/权益时两边同步；运行时真实判定以后端 /api 返回为准，本文件仅用于静态展示与付费墙。

// 价格单位：元（后端存分）
// 测试期全部 0.01 元（正式价：19/99/99/9.9/99）
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

// 合同文件上传大小上限（MB），与后端 PlanDef.maxUploadBytes 对齐
// FREE=8MB；PERSONAL / TEAM / ENTERPRISE 等会员档=15MB
export const UPLOAD_MAX_MB = { FREE: 8, PAID: 15 }

// 特性 key 与后端 Feature 对齐
export const PLAN_FEATURES = {
  FREE: {
    deep: false, playbook: false, wordExport: false, pdfFullExport: false,
    permanentStorage: false, clauseLibrary: false, ledgerUnlimited: false,
    teamCollaboration: false, feishu: false, ocr: true, longDocument: false,
  },
  PERSONAL: {
    deep: true, playbook: false, wordExport: true, pdfFullExport: true,
    permanentStorage: true, clauseLibrary: true, ledgerUnlimited: false,
    teamCollaboration: false, feishu: false, ocr: true, longDocument: true,
  },
  TEAM: {
    deep: true, playbook: true, wordExport: true, pdfFullExport: true,
    permanentStorage: true, clauseLibrary: true, ledgerUnlimited: true,
    teamCollaboration: true, feishu: true, ocr: true, longDocument: true,
  },
  ENTERPRISE: {
    deep: true, playbook: true, wordExport: true, pdfFullExport: true,
    permanentStorage: true, clauseLibrary: true, ledgerUnlimited: true,
    teamCollaboration: true, feishu: true, ocr: true, longDocument: true,
  },
}


