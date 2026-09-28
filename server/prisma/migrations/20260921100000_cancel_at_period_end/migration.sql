-- Phase 5：模拟取消订阅标记。权益保留至 plan_expires_at，到期由 subscription-expiry 定时任务降级 FREE。
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;
