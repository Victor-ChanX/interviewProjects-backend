# 多账号群组消息平台 —— 项目规划

> 交付期 48 小时，题量大于时间。原则：**按重要程度顺序做，每一步都停在可交付状态**；
> 每条需求在「服务任意时刻重启前后都必须成立」，所以可靠性语义优先于功能面。

## 1. 目标

后端代管若干服务账号，把它们连到一个外部消息网关（HTTP + SSE），维护账号状态；把群里收发的消息记成可靠的时间线；
按预设定时序列由指定角色的账号往群里发消息；接入一个按 tool-use 协议工作的 Agent 服务，让它能读群消息、发消息、移除成员。
操作员通过网页控制台管理这一切并实时看到发生了什么。两个外部服务由本仓自己的模拟器提供。

## 2. 架构

```
frontend/ (React 18 + Vite)          REST + WebSocket
        │
backend/ (Fastify + Prisma + PostgreSQL)
 ├─ api/        HTTP 边界（zod 校验、闸门、错误信封 { error: { code, message, requestId } }）
 ├─ services/   业务规则 + 数据访问（拒绝 = 领域异常 → 状态码）
 ├─ workers/    后台循环：出站派发 / 事件流消费 / 建群与退群 job / agent run / 序列排期 / 限流恢复
 ├─ db/         Prisma client、启动迁移与 schema 门禁
 └─ core/       配置、JWT、领域异常、时钟、日志
 ├─ sim/gateway/   消息网关模拟器（HTTP + SSE，可脚本化：202 / 429 / 504 / 重复 / 乱序 / 断流）
 └─ sim/agent/     Agent 服务模拟器（坏 JSON / 未知工具 / 重复 tool_use.id / 同 key 重试 / 慢响应）
```

**三条贯穿全局的设计决策**

1. **一切外部副作用走 outbox**：出站消息与业务写同一事务落库（`queued`），worker 领取（`FOR UPDATE SKIP LOCKED`）→ 调网关 → 记结果。
   崩溃只会留下「意图已记录、结果未记录」的行，重启后按状态机继续；永远不会出现「网关发了、库里没有」。
2. **一切入站按 at-least-once 处理**：事件流游标（`lastEventId`）落库，`(groupId, msgId)` / `eventId` 唯一约束去重；写库失败不中断消费，原始事件进 `inconsistencies` 并推给操作员。
3. **一切互斥与预算靠数据库，不靠进程内存**：「同群同时至多一个 running 的 run / 序列」用部分唯一索引；60 秒预算按落库的 `accumulatedMs + (now − activeSince)` 算，停机不计；定时器只是「多久看一次」，排期本身是库里的 `nextRunAt`。

## 3. 数据模型（Prisma）

| 表 | 用途 | 关键约束 |
|---|---|---|
| `accounts` | 服务账号：`status`（6 态）、`platformUserId`、`rateLimitedUntil`、`version`（CAS） | 终态转移在一个事务里级联 |
| `groups` / `group_members` | 群与成员（`role`、`platformUserId`）、`status`、`agentEnabled`、`autoKickEnabled` | 成员按 `member_joined/left` 事件维护 |
| `messages` | 时间线（入站 + 出站同一张表，一条一行）：`msgId`、`clientMsgId`、`sentAt`、`isOwn`、`deliveryStatus`、`failCode` | `unique(groupId, msgId)`；出站 `unique(clientMsgId)` |
| `outbound_attempts` | 每次投递尝试与结果（504 后的 by-client-id 查询、唯一一次重发） | 重发次数 ≤ 1 |
| `inbound_events` / `event_cursor` | 网关事件原文 + 处理状态；SSE 游标 | `unique(eventId)` |
| `jobs` / `job_errors` | 建群、leave-all 的异步任务 | `step` 枚举 |
| `agent_runs` / `agent_steps` / `agent_pending_messages` | run 状态机、每步（含协议错误步、`rawResponse` 2KB 截断）、待处理触发消息 | `unique(groupId) where status = 'running'`；`(runId, idempotencyKey)` |
| `sequences` / `sequence_runs` / `sequence_run_steps` | 序列定义、运行、步骤（`resolvedVars` / `varSources` / `scheduledAt`） | `unique(groupId) where status = 'running'` |
| `users` / `sessions` | admin / viewer；refresh token 轮换族（复用旧 token → 整族作废） | `tokenFamily` |
| `ws_events` | WebSocket 事件日志：全局单调 `seq`，重连按 `sinceSeq` 补发 | `seq` 自增 |
| `inconsistencies` | 写库失败等不一致，供操作员查看 | |

## 4. 里程碑与拆分

每个里程碑结束时：`main` 可运行、README 可照着跑、对应场景测试绿。任务按 GitHub issue 拆（后端仓 `#N`；前端仓标「前端 #N」），编号在下表「#」列；B4 的页面 4 / 5 是前端 #5 / #6。

### M0 · 骨架与模拟器（第 1 个半天）

| # | 任务 | 验收 |
|---|---|---|
| #1 | 骨架：backend / frontend 各自起仓、CI、README 启动说明 | `npm run dev` 两端都起得来 |
| #2 | 网关模拟器：账号 connect/disconnect、群/成员/邀请、send 的全部同步错误码、SSE 事件流（at-least-once + ≤1s 乱序 + 补投）、by-client-id 查询、`503` 整体不可用；**行为可按场景脚本化**（S1–S8 都能复现） | 模拟器自带用例 |
| #3 | Agent 模拟器：`/agent/turn` 合法响应 + 六类坏行为、`/agent/audit` 的 500 / 坏 JSON / 慢响应 | 模拟器自带用例 |
| #4 | Prisma 模型（第 3 节全部表）+ 初始迁移 + 种子（账号、admin/viewer） | 空库 `migrate deploy` 通过；schema 落后拒绝启动 |

### M1 · A0 + A1 + A2：账号、网关接入、时间线（第 1 天）

| # | 任务 | 验收 |
|---|---|---|
| #5 | 登录 / JWT / viewer 只读 403 / 错误信封 / `GET /api/health` | A0 |
| #6 | 账号状态机：转移表、`transition` 的 `expectedFrom` CAS、终态级联（移出成员、排队消息 cancelled、序列步骤 skipped、`account_terminal`）一个事务 | A1 用例 + 并发 CAS 用例 |
| #7 | 出站 outbox worker：`queued→accepted→sent/failed/unknown/cancelled`；429 → `rate_limited` 排队顺延、到期自动恢复；504 → `unknown` → by-client-id 确认 → 至多重发一次；`GROUP_WRITE_FORBIDDEN` → 群 `unreachable` 级联 | S1、S4、A2 错误表逐条 |
| #8 | 入站 SSE worker：游标落库、`since` 补拉、去重、乱序按 `sentAt`、自己消息回流 `isOwn`、写库失败 → `inconsistency` 不中断 | S2、S3 |
| #9 | 消息时间线游标分页（`before` 游标 = `(sentAt, msgId)`）+ WS 推送（`seq` 单调、认证帧） | A4 |
| #10 | **重启恢复用例**：worker 在「领取后 / 202 后记账前 / 记账后推进游标前」各停一次再启动，断言网关恰好一条 | 总则 |

### M2 · A3 + A5：建群、Agent 接入（第 2 天上午）

| # | 任务 | 验收 |
|---|---|---|
| #11 | 建群 job：create → invite（`INVITE_NOT_READY` 等待、`INVITE_EXPIRED` 重申请一次）→ join（`ALREADY_MEMBER` 视为成功）→ 等 `member_joined`（10s → `JOIN_TIMEOUT`）→ promote（`NOT_MEMBER_YET` 重试，总数 ≤ 2） | A3、B2 前半 |
| #12 | Agent run 循环：触发（非自己消息 + `agentEnabled`）、部分唯一索引保证单 running、待处理消息合并进下一次 run、12 步 / 60s / 连续 3 次协议错、每轮 10–15s 超时、审计 3 次 → `blocked`、执行账号选择、`kick_user` 的 `POLICY_DENIED` / `OWNER_LEFT` / `NO_PERMISSION`、幂等键、tool_result 8KB 截断、`cancelled` 条件、**每步落库以便重启续跑** | S5、S6、A5 全部 |
| #13 | `GET /api/agent-runs/:id`、`GET /api/groups/:id/agent-runs`、WS `agent_run` 事件 | |

### M3 · A6：控制台前端（第 2 天下午）

| # | 任务 | 验收 |
|---|---|---|
| 前端 #2 | 登录页；请求层 401 单飞刷新；viewer 隐藏写操作 | 页面 1 |
| 前端 #3 | 账号列表：状态、按转移表显示「标记离线 / 重连 / 释放」 | 页面 2 |
| 前端 #4 | 群详情：成员（role）、时间线（加载更早 + WS 实时追加不重不漏）、自己消息的 `deliveryStatus`、agent run 列表（`blocked` 醒目） | 页面 3 |

### M4 · B 组（剩余时间，按顺序）

| # | 任务 | 验收 |
|---|---|---|
| #15 | B1 定时序列：角色选账号（`rate_limited` 顺延、无人 `skipped`）、`vars/stepVars` 取值链 + `varSources`、预检 422、以 `message_sent` 为基准排期、重启只重排最早一步、并发启动 201/409 | S7、S8 |
| #16 | B2 leave-all：非群主先退、失败记入 `errors[]`、群主最后退；完成后成员表与网关一致 | |
| #17 | B3 会话：refresh token HttpOnly + 轮换 + 复用作废整族；logout 即失效；前端并发 401 只刷一次 | |
| #18 / 前端 #7 | B4：WS `sinceSeq` 补发（断线 3 秒内补齐不重复）；页面 4 agent 步骤详情、页面 5 序列运行 | |

### C 组（选做）

| # | 任务 | 状态 |
|---|---|---|
| 前端 #8 | C3 Playwright：登录 → 群列表 → 群详情 → agent run 详情看到每一步；viewer 只读。webServer 拉起两个模拟器、后端与 Vite，专用库每次重建；公开 CI 里并排 checkout 后端仓跑 | 已完成 |
| | C1 媒体文件下载与清理 | 未做（入站事件已把 `mediaUrl` 存进 `messages.media_url` 与原始 payload，下载 worker 可直接接） |
| | C2 接入真实 LLM | 未做（Agent 客户端只依赖 `AGENT_URL` 与 2.2 的协议，换服务不改后端） |

## 5. 测试策略

- 每个业务面四类用例：主流程 / 业务边界 / 数据范围 / 状态机非法转移；外加**重启恢复**与**并发互斥**两类。
- 全部跑真实 PostgreSQL（每次一个临时 schema）；外部服务用本仓模拟器按用例脚本化，不 mock 数据库。
- 典型场景 S1–S8 各一条集成测试，作为交付验收清单。

## 6. 风险与取舍

| 风险 | 对策 |
|---|---|
| 时间不够 | 严格按 M0→M4 顺序；每个里程碑结束即可交付 |
| 网关/Agent 模拟器行为不够「坏」，测不出可靠性缺陷 | M0 就把 8 个场景脚本化；模拟器有自己的用例 |
| 多实例语义（同群单 run）在单进程演示里看不出来 | 用数据库约束实现，并写「两次并发启动恰好一个成功」的用例 |
| 重启恢复靠肉眼 | 用 `worker.stop()/start()` 在关键缝上停机的自动化用例覆盖 |
