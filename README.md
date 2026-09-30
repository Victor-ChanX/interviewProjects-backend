# 多账号群组消息平台 · 后端

Node + TypeScript + Fastify + Prisma + PostgreSQL。控制台在
[interviewProjects-frontend](https://github.com/Victor-ChanX/interviewProjects-frontend)。
规划与任务拆分见 [docs/plan.md](docs/plan.md)。

## 运行

前提：Node ≥ 22.18、PostgreSQL 14+。

```bash
cp .env.example .env            # DATABASE_URL / PORT / GATEWAY_URL / AGENT_URL
npm install                     # postinstall 生成 Prisma client
npm run db:deploy               # 前滚迁移（启动时也会自动执行）
npm run dev
```

测试：`DATABASE_URL=… npm test`（真实 PostgreSQL，每次自动建临时 schema）。
