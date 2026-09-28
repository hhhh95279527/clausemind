-- integration_leads.user_id 补外键（P2-12）：用户删除后悬空值置 NULL。
-- 先清理历史悬空引用，避免加约束失败。
UPDATE integration_leads il
SET user_id = NULL
WHERE user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = il.user_id);

ALTER TABLE integration_leads
  ADD CONSTRAINT integration_leads_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
