-- 修复迁移漂移：以下 DDL 此前只在本地库手工执行过、未落迁移文件，
-- 导致 CI（全新空库）在 seed 阶段报 `orders.pay_proof does not exist`（P2022）。
-- 全部语句带 IF NOT EXISTS / IF EXISTS 守卫，可安全重复执行。

-- 1) orders.pay_proof：20261013060000_trial_usage_and_transfer_orders 遗漏的转账凭证列
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pay_proof" JSONB;

-- 2) refund_requests：20261015160000_refund_requests 遗漏的真实退款回款 4 列
ALTER TABLE "refund_requests"
ADD COLUMN IF NOT EXISTS "refund_channel" VARCHAR(20);

ALTER TABLE "refund_requests"
ADD COLUMN IF NOT EXISTS "refund_account" VARCHAR(100);

ALTER TABLE "refund_requests"
ADD COLUMN IF NOT EXISTS "refund_account_name" VARCHAR(50);

ALTER TABLE "refund_requests"
ADD COLUMN IF NOT EXISTS "refund_transfer_no" VARCHAR(100);

-- 3) platform_docs：平台功能知识库（任务 Agent platform_help 工具数据源），从未建迁移
CREATE TABLE IF NOT EXISTS "platform_docs" (
    "id" TEXT NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "content" TEXT NOT NULL,
    "plans" VARCHAR(60) NOT NULL DEFAULT 'FREE,PERSONAL,TEAM,ENTERPRISE',
    "keywords" VARCHAR(200) NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_docs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "platform_docs_enabled_sort_order_idx" ON "platform_docs" ("enabled", "sort_order");

-- 4) contracts.retain_until：schema 里的 @@index 此前未落迁移（仅影响查询性能）
CREATE INDEX IF NOT EXISTS "contracts_retain_until_idx" ON "contracts" ("retain_until");

-- 注：TenantPlan 枚举在 fresh 库仍会保留 PRO/ENT 变体（schema 已移除），
-- 属无害漂移：Prisma client 不会写入这两个值，且 ALTER TYPE ... DROP VALUE IF EXISTS
-- 是 PG17+ 语法（本机/CI 为 PG16 不支持），为保证迁移幂等稳健此处不做枚举清理。