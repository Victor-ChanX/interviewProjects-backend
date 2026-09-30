# 后端镜像：一份镜像四种用法（docker-compose.yml 里按 command 区分）——
#   后端 API + worker：node dist/main.js（默认）
#   消息网关模拟器：    node dist/sim/gateway/main.js
#   Agent 服务模拟器：  node dist/sim/agent/main.js
#   真实 LLM Agent：    node dist/llm-agent/main.js
# 运行期不用 tsx：builder 层 tsc 编译到 dist。启动时 runMigrations 调 node_modules/.bin/prisma
# 跑 migrate deploy，所以 prisma CLI 在 dependencies 里，prisma/ 与 prisma.config.ts 也要进镜像。

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
# openssl：Prisma 的 schema engine 需要；curl：在容器里按人工测试手册调模拟器的 /_sim/* 端点
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- 编译：全量依赖（postinstall 的 prisma generate 产出 src/db/generated）→ tsc 到 dist ----
FROM base AS build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- 运行期依赖：不装 devDependencies ----
FROM base AS prod-deps
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# ---- 运行镜像 ----
FROM base AS runtime
ENV NODE_ENV=production \
  NODE_OPTIONS=--enable-source-maps \
  LLM_AGENT_CONFIG_FILE=/data/llm-agent.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
# /data：llm-agent 在控制台保存的模型配置与会话状态（compose 里挂命名卷）
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
