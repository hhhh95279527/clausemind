-- 双轨支付/真实退款：增量加列（避免 db push 全量 diff 的历史漂移问题）
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pay_proof" JSONB;
ALTER TABLE "refund_requests" ADD COLUMN IF NOT EXISTS "refund_channel" VARCHAR(20);
ALTER TABLE "refund_requests" ADD COLUMN IF NOT EXISTS "refund_account" VARCHAR(100);
ALTER TABLE "refund_requests" ADD COLUMN IF NOT EXISTS "refund_account_name" VARCHAR(50);
ALTER TABLE "refund_requests" ADD COLUMN IF NOT EXISTS "refund_transfer_no" VARCHAR(100);
