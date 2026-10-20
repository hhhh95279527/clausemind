FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# 统一走国内镜像源 + 重写 lock 里的 tar 主机 + 加大重试/超时，避免容器内网络偶发超时
RUN npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && (sed -i 's#https://registry\.npmjs\.org#https://registry.npmmirror.com#g' package-lock.json || true) \
 && npm install
COPY . .
# 小内存服务器（或低配容器）构建时 Vite 会触发 V8 默认堆上限导致 OOM（Ineffective mark-compacts near heap limit）。
# 显式抬高 Node 堆上限；配合 swap 可完成构建。
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
