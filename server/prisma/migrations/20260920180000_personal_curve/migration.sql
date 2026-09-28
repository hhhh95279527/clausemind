-- Phase 4 个人曲线：合同场景、审查深度标记、AI 改稿字段
-- 手写迁移（禁用 prisma migrate dev）

-- 1. 合同审查场景枚举（FREE 仅前四类，CUSTOM 非标仅深度套餐/券）
CREATE TYPE "ReviewScene" AS ENUM ('LABOR', 'LEASE', 'SERVICE', 'NDA', 'CUSTOM');
ALTER TABLE "contracts" ADD COLUMN "scene" "ReviewScene" NOT NULL DEFAULT 'LABOR';

-- 2. 审查任务：本次是否走 Agent 深度轨 / 是否深度券核销（结果页三态依据）
ALTER TABLE "review_tasks" ADD COLUMN "is_deep" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "review_tasks" ADD COLUMN "coupon_used" BOOLEAN NOT NULL DEFAULT false;

-- 3. 风险：AI 改写句与改稿台接受状态（复用 risks 表，不新增表）
ALTER TABLE "risks" ADD COLUMN "rewritten" TEXT;
ALTER TABLE "risks" ADD COLUMN "revision_status" VARCHAR(20) NOT NULL DEFAULT 'NONE';
