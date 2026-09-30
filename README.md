# 多账号群组消息平台 · 后端

Node 22 + TypeScript + Fastify + Prisma + PostgreSQL。控制台在
[interviewProjects-frontend](https://github.com/Victor-ChanX/interviewProjects-frontend)。
规划、数据模型与任务拆分见 [docs/plan.md](docs/plan.md)；题目要求的两个外部服务（消息网关、Agent 服务）
由本仓的模拟器提供，行为可按场景脚本化。

## 运行

前提：Node ≥ 22.18、PostgreSQL 14+（本机能 `CREATE DATABASE`，迁移漂移检查会临时建库）。

```bash
cp .env.example .env            # 填 DATABASE_URL（连接串要带用户名）、JWT_SECRET、GATEWAY_URL、AGENT_URL
npm install                     # postinstall 生成 Prisma client（src/db/generated/，不进 git）

# 三个进程各开一个终端
npm run sim:gateway             # 消息网关模拟器  http://localhost:8100（SIM_GATEWAY_PORT）
npm run sim:agent               # Agent 服务模拟器 http://localhost:8200（SIM_AGENT_PORT）
npm run dev                     # 后端 http://localhost:8000：启动时前滚迁移 → 校验 schema → 幂等种子 → 起 worker → listen
```

启动即预置：账号 `acc-1` … `acc-5`（`idle`）、用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）。
健康：`GET /api/health` → `{ ok, schemaVersion }`。

## 一分钟走一遍

```bash
TOKEN=$(curl -s localhost:8000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r .accessToken)
H="Authorization: Bearer $TOKEN"

curl -s -X POST localhost:8000/api/accounts/acc-1/connect -H "$H"          # idle → online
curl -s -X POST localhost:8000/api/accounts/acc-2/connect -H "$H"
curl -s localhost:8000/api/groups -H "$H" -H 'content-type: application/json' \
  -d '{"creatorAccountId":"acc-1","memberAccountIds":["acc-2"]}'           # 202 { jobId }
curl -s localhost:8000/api/jobs/<jobId> -H "$H"                            # running → finished
curl -s localhost:8000/api/groups -H "$H"                                  # 拿 group id
curl -s -X POST localhost:8000/api/groups/<id>/send -H "$H" -H 'content-type: application/json' \
  -d '{"accountId":"acc-1","text":"hello"}'                                # 202 { clientMsgId }
curl -s "localhost:8000/api/groups/<id>/messages?limit=50" -H "$H"         # queued → accepted → sent
```

WebSocket：`ws://localhost:8000/ws`，第一帧 `{ "type": "auth", "accessToken": "…", "sinceSeq"?: n }`，
之后收 `{ seq, type, payload }`（`account_status_changed` / `account_terminal` / `inconsistency` / `message` /
`agent_run` / `sequence_run` …）。

## 复现题目 2.4 的典型场景

网关与 Agent 模拟器都有 `/_sim/scenario`、`/_sim/state`、`/_sim/reset` 管理端点；S1–S8 各自怎么配写在
[src/sim/gateway/README.md](src/sim/gateway/README.md)（网关侧）与 [src/sim/agent/scenario.ts](src/sim/agent/scenario.ts)
（Agent 剧本 DSL）。例如让每个事件推两次（S2）：

```bash
curl -s localhost:8100/_sim/scenario -H 'content-type: application/json' -d '{"events":{"duplicates":2}}'
```

自动化版本：`tests/scenarios-m1.test.ts`（S1–S4）、`tests/scenarios-m2.test.ts`（S5、S6 经 SSE 触发的全链路）、
`tests/sequences*.test.ts`（S7、S8），以及 `tests/recovery-m1.test.ts` / `tests/agent-run.test.ts` 里在各个「缝」上停机再启动的恢复用例。

## 测试

全部跑真实 PostgreSQL：每个测试文件在 `DATABASE_URL` 所在库里建一个临时 schema、跑迁移链、结束后删掉；
外部服务用本仓模拟器起在随机端口；不 mock 数据库、禁外网。

```bash
DATABASE_URL=postgres://<user>@localhost:5432/<db> npm test
npm run test:coverage
```

浏览器端到端（Playwright：登录 → 群详情 → agent run 每一步）在前端仓：并排 checkout 两个仓后在前端仓跑它的 e2e 脚本，
它会自己拉起本仓的两个模拟器与后端，见前端仓 README「端到端」。

## 目录

```
src/api/        HTTP 边界：路由 + zod schema + 闸门（requireUser / requireRole）；不做数据访问
src/services/   业务规则 + 数据访问；拒绝 = 领域异常 → 错误信封 { error: { code, message, requestId } }
src/workers/    出站 outbox / 入站事件流 / 建群与退群 job / agent run / 定时序列 / 限流恢复 / WS 广播
src/db/         Prisma client、启动迁移与 schema 门禁、幂等种子
src/core/       配置、JWT、领域异常、时钟、日志
src/sim/        网关与 Agent 模拟器（独立进程）
prisma/         schema 与迁移（部分唯一索引、CHECK 约束手写在迁移里）
tests/          vitest（真库）
```

三条贯穿全局的设计：外部副作用一律走 outbox（先落库再发，504 后按 clientMsgId 确认没发出才重发一次）；
入站按 at-least-once 处理（eventId / (groupId, msgId) 去重，游标落库）；互斥与预算靠数据库
（部分唯一索引保证同群单 run / 单序列，预算按落库时间戳累计，停机不计）。
