-- 企业自有合同范本库：上传范本 → AI 提炼审查规则（人工确认后导入 playbook_rules）
-- 删范本不级联已导入的规则（规则独立生效）；租户删除时随租户级联清除
CREATE TABLE "tenant_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" VARCHAR(50) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_path" VARCHAR(500) NOT NULL,
    "file_type" VARCHAR(20) NOT NULL,
    "file_size" INTEGER NOT NULL,
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "uploaded_by_id" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_templates_tenant_id_created_at_idx" ON "tenant_templates"("tenant_id", "created_at");

ALTER TABLE "tenant_templates" ADD CONSTRAINT "tenant_templates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_templates" ADD CONSTRAINT "tenant_templates_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
