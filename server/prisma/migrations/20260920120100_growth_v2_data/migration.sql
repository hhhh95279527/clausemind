-- ClauseMind 产品化改造 v2 · 字段扩展、新表与老套餐映射
-- 依赖上一条迁移已提交的枚举值（PERSONAL/TEAM/ENTERPRISE 等）。

-- ── 1. tenants 扩展 ────────────────────────────────────────────────────────
ALTER TABLE "tenants" ADD COLUMN "workspace_type" "WorkspaceType" NOT NULL DEFAULT 'PERSONAL';
ALTER TABLE "tenants" ADD COLUMN "coupon_balance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN "plan_updated_at" TIMESTAMP(3);

-- 老套餐映射：PRO→TEAM（团队版），ENT→ENTERPRISE（企业版）；FREE 保持
UPDATE "tenants" SET "plan" = 'TEAM',        "plan_updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'PRO';
UPDATE "tenants" SET "plan" = 'ENTERPRISE',  "plan_updated_at" = CURRENT_TIMESTAMP WHERE "plan" = 'ENT';

-- ── 2. users 扩展 ──────────────────────────────────────────────────────────
-- onboarding_completed：3 步欢迎引导是否完成
-- email_verified：邮箱验证码登录/验证标记
-- metadata：个人轻量资产（个人条款库 / 关注风险 / 审查偏好），不另建表
ALTER TABLE "users" ADD COLUMN "onboarding_completed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "metadata" JSONB;

-- ── 3. contracts 扩展 ──────────────────────────────────────────────────────
-- retain_until：FREE 空间合同保留截止时间（每日定时清理依据）；付费置 NULL=永久
ALTER TABLE "contracts" ADD COLUMN "retain_until" TIMESTAMP(3);

-- ── 4. 合同台账 contract_ledgers ───────────────────────────────────────────
-- contract_type 字符串枚举 7 类：FIXED_TERM_LABOR/OPEN_ENDED_LABOR/SERVICE/INTERNSHIP/NDA/NON_COMPETE/OTHER
CREATE TABLE "contract_ledgers" (
    "id"                VARCHAR(50) NOT NULL,
    "tenant_id"         VARCHAR(50) NOT NULL,
    "employee_name"     VARCHAR(100) NOT NULL,
    "dept"              VARCHAR(100),
    "contract_type"     VARCHAR(30) NOT NULL DEFAULT 'FIXED_TERM_LABOR',
    "start_date"        DATE NOT NULL,
    "end_date"          DATE,
    "probation_end"     DATE,
    "position"          VARCHAR(100),
    "note"              TEXT,
    "status"            "LedgerStatus" NOT NULL DEFAULT 'ACTIVE',
    "linked_contract_id" VARCHAR(50),
    "renewed_from_id"   VARCHAR(50),
    "remind_before_days" INTEGER NOT NULL DEFAULT 30,
    "created_by_id"     VARCHAR(50),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_ledgers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contract_ledgers_tenant_id_status_idx"   ON "contract_ledgers"("tenant_id", "status");
CREATE INDEX "contract_ledgers_tenant_id_end_date_idx" ON "contract_ledgers"("tenant_id", "end_date");

ALTER TABLE "contract_ledgers"
ADD CONSTRAINT "contract_ledgers_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contract_ledgers"
ADD CONSTRAINT "contract_ledgers_linked_contract_id_fkey"
FOREIGN KEY ("linked_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "contract_ledgers"
ADD CONSTRAINT "contract_ledgers_renewed_from_id_fkey"
FOREIGN KEY ("renewed_from_id") REFERENCES "contract_ledgers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "contract_ledgers"
ADD CONSTRAINT "contract_ledgers_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 5. Playbook 审查规则 playbook_rules ────────────────────────────────────
CREATE TABLE "playbook_rules" (
    "id"             VARCHAR(50) NOT NULL,
    "tenant_id"      VARCHAR(50) NOT NULL,
    "kind"           "PlaybookKind" NOT NULL DEFAULT 'FORBIDDEN',
    "title"          VARCHAR(200) NOT NULL,
    "description"    TEXT,
    "natural_prompt" TEXT NOT NULL DEFAULT '',
    "pattern"        JSONB,
    "contract_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled"        BOOLEAN NOT NULL DEFAULT true,
    "hit_count"      INTEGER NOT NULL DEFAULT 0,
    "source"         "PlaybookSource" NOT NULL DEFAULT 'MANUAL',
    "created_by_id"  VARCHAR(50),
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbook_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "playbook_rules_tenant_id_enabled_idx" ON "playbook_rules"("tenant_id", "enabled");

ALTER TABLE "playbook_rules"
ADD CONSTRAINT "playbook_rules_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playbook_rules"
ADD CONSTRAINT "playbook_rules_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 6. 模拟订单 orders ─────────────────────────────────────────────────────
CREATE TABLE "orders" (
    "id"            VARCHAR(50) NOT NULL,
    "tenant_id"     VARCHAR(50) NOT NULL,
    "kind"          "OrderKind" NOT NULL,
    "period"        "OrderPeriod",
    "target_plan"   VARCHAR(20),
    "coupon_qty"    INTEGER,
    "amount_fen"    INTEGER NOT NULL DEFAULT 0,
    "status"        "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" VARCHAR(50),
    "paid_at"       TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "orders_tenant_id_created_at_idx" ON "orders"("tenant_id", "created_at");
CREATE INDEX "orders_status_idx"               ON "orders"("status");

ALTER TABLE "orders"
ADD CONSTRAINT "orders_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orders"
ADD CONSTRAINT "orders_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 7. 自研埋点事件 analytics_events ───────────────────────────────────────
-- 只采事件与属性元数据；tenant_id/user_id 可空（未登录匿名事件）
CREATE TABLE "analytics_events" (
    "id"         VARCHAR(50) NOT NULL,
    "tenant_id"  VARCHAR(50),
    "user_id"    VARCHAR(50),
    "type"       VARCHAR(50) NOT NULL,
    "path"       VARCHAR(500),
    "props"      JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "analytics_events_tenant_id_created_at_idx" ON "analytics_events"("tenant_id", "created_at");
CREATE INDEX "analytics_events_type_created_at_idx"      ON "analytics_events"("type", "created_at");

-- ── 8. 集成配置 integration_configs（P0 飞书 Webhook）──────────────────────
-- 一个租户对一种提供方仅一条配置
CREATE TABLE "integration_configs" (
    "id"           VARCHAR(50) NOT NULL,
    "tenant_id"    VARCHAR(50) NOT NULL,
    "provider"     "IntegrationProvider" NOT NULL DEFAULT 'FEISHU',
    "config"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "status"       "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "last_test_at" TIMESTAMP(3),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_configs_tenant_id_provider_key"
ON "integration_configs"("tenant_id", "provider");

ALTER TABLE "integration_configs"
ADD CONSTRAINT "integration_configs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
