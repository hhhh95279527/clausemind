-- 法规问答：文档按会话隔离
-- ALTER: "documents" 增加 session_id，关联 chat_sessions，会话删除时级联删除文档
ALTER TABLE "documents" ADD COLUMN "session_id" TEXT;

ALTER TABLE "documents" ADD CONSTRAINT "documents_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "documents_session_id_idx" ON "documents"("session_id");
