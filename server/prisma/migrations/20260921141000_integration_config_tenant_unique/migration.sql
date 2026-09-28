-- 修正 integration_configs 唯一约束：Prisma schema 声明 tenant_id @unique
-- （provider 当前仅 FEISHU，复合唯一在数据上等价；补齐单列唯一以匹配 upsert 的 ON CONFLICT）
CREATE UNIQUE INDEX IF NOT EXISTS "integration_configs_tenant_id_key"
    ON "integration_configs"("tenant_id");
