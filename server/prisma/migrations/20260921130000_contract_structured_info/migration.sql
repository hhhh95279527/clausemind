-- 6.2 企业审查台「结构化信息」卡：AI 抽取的金额/期限/付款节点/关键义务（JSONB，可空；无 Key 不生成）
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "structured_info" JSONB;
