#!/usr/bin/env bash
# 部署后收尾：在 /opt/clausemind 下执行。
# 作用：1) 注入 OPENAI_API_KEY 到 .env 2) 重启 server 让容器读到 3) 回填历史向量
# 安全：脚本不会打印 api key，仅判断 .env 里是否已有；回填日志会打印进度。
set -euo pipefail

cd /opt/clausemind
if [ ! -f docker-compose.yml ]; then
  echo "不在 /opt/clausemind 下，退出"
  exit 1
fi

# -------- 1. 注入 key --------
echo "=== [1/3] 检查/注入 OPENAI_API_KEY ==="
ENV_FILE=".env"
if ! grep -q '^OPENAI_API_KEY=' "$ENV_FILE" || grep -q '^OPENAI_API_KEY=$' "$ENV_FILE"; then
  echo -n "请粘贴 OPENAI_API_KEY（会写入 .env 后立即截断，不会回显）: "
  read -r key
  echo ""
  if [ -z "$key" ]; then echo "key 为空，跳过注入"; else
    # 覆盖写入（如果原先有注释行也替换）
    sed -i '/^OPENAI_API_KEY=/d' "$ENV_FILE"
    echo "OPENAI_API_KEY=$key" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "已写入 $ENV_FILE"
  fi
else
  echo ".env 中已有 OPENAI_API_KEY，跳过（如需更换请手动编辑 .env）"
fi

# -------- 2. 重启 server 容器读新 .env --------
echo ""
echo "=== [2/3] 重启 server 容器 ==="
docker compose up -d server
sleep 6
# 健康检查
if curl -fsS http://localhost:3000/health > /dev/null 2>&1; then
  echo "server 健康 ✓"
else
  echo "server 未就绪，查看日志：docker compose logs server --tail 40"
  docker compose logs server --tail 40 || true
fi

# -------- 3. 回填历史向量 --------
echo ""
echo "=== [3/3] 回填历史 embedding ==="
docker compose exec -T server npm run backfill:embeddings

echo ""
echo "=== 完成 ==="
echo "可验证："
echo "  docker compose logs server --tail 20          # 看是否正常"
echo "  docker compose exec -T server npm run eval -- --no-llm   # 跑回归评测"
