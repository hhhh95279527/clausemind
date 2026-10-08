# server/Dockerfile
FROM node:20-alpine

# Prisma 的 schema/query engine 在 Alpine 上依赖 openssl，缺失会导致 migrate 与运行时崩溃
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json tsconfig*.json ./
# 统一走国内镜像源 + 重写 lock 里的 tar 主机 + 加大重试/超时，避免容器内网络偶发超时
RUN npm config set registry https://registry.npmmirror.com \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 600000 \
  && sed -i 's#https://registry\.npmjs\.org#https://registry.npmmirror.com#g' package-lock.json \
  && npm install --legacy-peer-deps

# Prisma schema / migrations：prisma generate 与容器启动时 migrate deploy 必需
COPY prisma ./prisma
# dev 期 ESM 路径解析桥，ts-node 执行 seed 时需要
COPY register-js-ext.cjs ./
COPY src/ ./src/

# 编译 TypeScript（保留 devDependencies：容器启动需用 ts-node 跑幂等 seed）
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 兼容 Windows 检出时可能带的 CRLF，并赋予执行权限
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://localhost:3000/health/live || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
