#!/bin/sh
# 容器启动入口：迁移数据库 -> 写入幂等种子 -> 启动服务
set -e

echo "==> [1/2] 应用数据库迁移 (prisma migrate deploy)"
npx prisma migrate deploy

echo "==> [2/2] 写入幂等种子数据（规则 / 法规 / 样例合同 / 演示账号）"
# 种子失败不阻断启动（种子幂等，异常时查看日志即可）
npm run seed || echo "!! seed 执行失败，不影响服务启动，请检查上方日志"

echo "==> 启动应用: $*"
exec "$@"
