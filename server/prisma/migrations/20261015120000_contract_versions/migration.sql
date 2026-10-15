-- 合同文档版本归档：原件（引用 contracts.storage_path）/ 审查意见书 / 红划线修订稿
-- 每次导出修订稿归档一版，终审通过归档意见书一版，时间线按 created_at 倒序展示
CREATE TABLE "contract_versions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "task_id" TEXT,
    "kind" VARCHAR(20) NOT NULL,
    "file_name" VARCHAR(300) NOT NULL,
    "storage_path" VARCHAR(500) NOT NULL,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "applied_count" INTEGER,
    "unmatched_count" INTEGER,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contract_versions_contract_id_created_at_idx" ON "contract_versions"("contract_id", "created_at" DESC);

ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "review_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
