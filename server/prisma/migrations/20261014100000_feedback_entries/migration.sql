-- 建议/意见反馈表（个人版与企业版用户均可提交，提交后异步邮件通知平台）
CREATE TABLE "feedback_entries" (
    "id"          VARCHAR(50) NOT NULL,
    "tenant_id"   VARCHAR(50) NOT NULL,
    "user_id"     VARCHAR(50),
    "category"    VARCHAR(20) NOT NULL DEFAULT 'OTHER',
    "content"     VARCHAR(1000) NOT NULL,
    "contact"     VARCHAR(100),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_entries_tenant_id_created_at_idx"
    ON "feedback_entries"("tenant_id", "created_at");

CREATE INDEX "feedback_entries_user_id_idx"
    ON "feedback_entries"("user_id");

ALTER TABLE "feedback_entries"
    ADD CONSTRAINT "feedback_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "feedback_entries"
    ADD CONSTRAINT "feedback_entries_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
