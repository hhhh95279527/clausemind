-- 试用计量表 + 订单转账字段（转账人工确认收款）
CREATE TABLE IF NOT EXISTS "trial_usages" (
    "id" VARCHAR(50) NOT NULL,
    "tenant_id" VARCHAR(50) NOT NULL,
    "feature" VARCHAR(20) NOT NULL,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_usages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "trial_usages_tenant_id_feature_key" ON "trial_usages"("tenant_id", "feature");

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pay_channel" VARCHAR(20);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "transfer_no" VARCHAR(100);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "reject_reason" VARCHAR(500);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmed_by_id" VARCHAR(50);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ(6);
