-- 埋点事件表增加匿名设备 ID：打通访客（注册前）与注册后用户的漏斗前置环节
ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "anonymous_id" VARCHAR(50);
CREATE INDEX IF NOT EXISTS "analytics_events_anonymous_id_created_at_idx" ON "analytics_events"("anonymous_id", "created_at");
