-- 个人版有效期（Phase 4 额度卡展示；Phase 5 收银台支付成功后写入/续期）
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan_expires_at" TIMESTAMPTZ;
