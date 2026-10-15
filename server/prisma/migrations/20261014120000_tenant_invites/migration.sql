-- 团队邀请链接表（管理员生成链接 → 受邀人公开注册 → PENDING → 管理员审批）
CREATE TABLE "tenant_invites" (
    "id"              VARCHAR(50) NOT NULL,
    "tenant_id"       VARCHAR(50) NOT NULL,
    "created_by"      VARCHAR(50) NOT NULL,
    "token"           VARCHAR(64) NOT NULL,
    "expires_at"      TIMESTAMP(3) NOT NULL,
    "accepted_count"  INTEGER NOT NULL DEFAULT 0,
    "revoked_at"      TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_invites_token_key" ON "tenant_invites"("token");
CREATE INDEX "tenant_invites_tenant_id_idx" ON "tenant_invites"("tenant_id");

ALTER TABLE "tenant_invites"
    ADD CONSTRAINT "tenant_invites_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
