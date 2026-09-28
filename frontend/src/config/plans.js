// frontend/src/config/plans.js
// 套餐权益【展示镜像】，唯一事实源在后端 server/src/billing/plans.config.ts
// 改价格/权益时两边同步；运行时真实判定以后端 /api 返回为准，本文件仅用于静态展示与付费墙。

export const PLAN_CODES = {
  FREE: 'FREE',
  PERSONAL: 'PERSONAL',
  TEAM: 'TEAM',
  ENTERPRISE: 'ENTERPRISE',
}

// 价格单位：元（后端存分）
export const PRICES = {
  PERSONAL_MONTHLY: 19,
  PERSONAL_YEARLY: 99,
  TEAM_PER_SEAT_MONTHLY: 99,
  COUPON_UNIT: 9.9,
  COUPON_PACK_QTY: 10,
  COUPON_PACK: 99,
}

export const FREE_LIMITS = {
  monthlyReviews: 2,
  maxChars: 3000,
  retentionDays: 7,
  ledgerMaxItems: 10,
  // 免费可审四类场景（非标合同付费）
  allowedScenes: ['LABOR', 'LEASE', 'SERVICE', 'NDA'],
}

export const SCENE_OPTIONS = [
  { code: 'LABOR',  label: '劳动合同' },
  { code: 'LEASE',  label: '租赁合同' },
  { code: 'SERVICE', label: '劳务/兼职' },
  { code: 'NDA',    label: 'NDA 保密协议' },
  { code: 'CUSTOM', label: '非标合同' },
]

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

export const PLAN_LABELS = {
  FREE: '免费版',
  PERSONAL: '个人版',
  TEAM: '团队版',
  ENTERPRISE: '企业版',
}

export const PLAN_SEATS = { FREE: 1, PERSONAL: 1, TEAM: 5, ENTERPRISE: null }

// PLAN_LIMIT reason 中文标题（付费墙标题=被拦能力）
export const LIMIT_REASON_TEXT = {
  MONTHLY_QUOTA: '本月免费份数已用尽',
  CHAR_LIMIT: '文档超出免费字数',
  CONTRACT_TYPE: '非标合同需付费审查',
  DEEP_FEATURE: '深度能力为付费功能',
  EXPORT: '导出为付费功能',
  LEDGER_LIMIT: '台账条数已达上限',
  PLAYBOOK: 'Playbook 为团队版能力',
  TEAM_SPACE: '该功能属于团队空间',
  SEAT_LIMIT: '团队席位已用尽',
  COUPON_REQUIRED: '深度券余额不足',
}
