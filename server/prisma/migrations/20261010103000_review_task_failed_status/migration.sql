-- 审查任务新增 FAILED 状态：标记因服务重启 / SSE 断连而中断、未完成汇总的僵死任务
ALTER TYPE "ReviewTaskStatus" ADD VALUE 'FAILED';
