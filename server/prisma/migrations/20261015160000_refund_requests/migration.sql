-- 退款工单：申请（订单+原因+附件）→ AI 客服会话（可转人工）→ 超管处理
-- 同意退款 = 订单标 REFUNDED + 权益降级；拒绝 = 工单关闭，订单不变

-- 订单状态新增"已退款"（未在本迁移内使用，事务安全）
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED';

CREATE TYPE "RefundStatus" AS ENUM ('CHAT', 'AGENT', 'RESOLVED');
CREATE TYPE "RefundSender" AS ENUM ('USER', 'AI', 'AGENT', 'SYSTEM');

CREATE TABLE "refund_requests" (
    "id" VARCHAR(50) NOT NULL,
    "tenant_id" VARCHAR(50) NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "order_id" VARCHAR(50) NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "description" VARCHAR(1000),
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "RefundStatus" NOT NULL DEFAULT 'CHAT',
    "resolution" VARCHAR(20),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refund_messages" (
    "id" VARCHAR(50) NOT NULL,
    "request_id" VARCHAR(50) NOT NULL,
    "sender" "RefundSender" NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refund_requests_tenant_id_created_at_idx" ON "refund_requests"("tenant_id", "created_at");
CREATE INDEX "refund_requests_status_created_at_idx" ON "refund_requests"("status", "created_at");
CREATE INDEX "refund_requests_order_id_idx" ON "refund_requests"("order_id");
CREATE INDEX "refund_messages_request_id_created_at_idx" ON "refund_messages"("request_id", "created_at");

ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refund_messages" ADD CONSTRAINT "refund_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "refund_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
