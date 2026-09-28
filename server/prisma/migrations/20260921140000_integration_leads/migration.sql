-- 集成中心「联系开通」留资表
CREATE TABLE "integration_leads" (
    "id"           VARCHAR(50) NOT NULL,
    "tenant_id"    VARCHAR(50) NOT NULL,
    "user_id"      VARCHAR(50),
    "integration"  VARCHAR(30) NOT NULL,
    "name"         VARCHAR(100) NOT NULL,
    "phone"        VARCHAR(30) NOT NULL,
    "note"         VARCHAR(500),
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "integration_leads_tenant_id_created_at_idx"
    ON "integration_leads"("tenant_id", "created_at");

ALTER TABLE "integration_leads"
    ADD CONSTRAINT "integration_leads_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
