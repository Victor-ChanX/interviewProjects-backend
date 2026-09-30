# 多账号群组消息平台 · 后端

Node 22 + TypeScript + Fastify + Prisma + PostgreSQL。控制台（React）在
[interviewProjects-frontend](https://github.com/Victor-ChanX/interviewProjects-frontend)。
题目要求的两个外部服务（消息网关、Agent 服务）由本仓的模拟器提供，行为可按场景脚本化；另有一个接真实 Claude / Gemini 的
Agent 服务（题目 C2）。规划、数据模型与任务拆分见 [docs/plan.md](docs/plan.md)。

## 本地跑起来

前提：**Node ≥ 22.18**、**PostgreSQL 14+**（连接用的角色要能 `CREATE DATABASE`：测试与迁移漂移检查会临时建 schema / 库）。
想用控制台的话，把前端仓与本仓并排 clone（`../interviewProjects-frontend`）。

```bash
# 1. 建库、配环境变量
createdb group_message_platform
cp .env.example .env            # 改 DATABASE_URL（连接串要带用户名）与 JWT_SECRET（≥ 32 字符，openssl rand -hex 32）

# 2. 装依赖（postinstall 会生成 Prisma client 到 src/db/generated/，不进 git）
npm install

# 3. 三个进程各开一个终端
npm run sim:gateway             # 消息网关模拟器  http://localhost:8100
npm run sim:agent               # Agent 服务模拟器 http://localhost:8200
npm run dev                     # 后端 http://localhost:8000（读 .env；启动时前滚迁移 → 校验 schema → 幂等种子 → 起 worker → listen）

# 4. 验证
curl -s localhost:8000/api/health  # {"ok":true,"schemaVersion":"…"}
```

启动即预置：账号 `acc-1` … `acc-5`（`idle`）、用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）。
接口：路由在 `src/api/routes/`，请求 / 响应的 zod schema 在 `src/schemas/`（错误一律 `{ error: { code, message, requestId } }`）。

**控制台**：在前端仓 `cp .env.example .env && npm install && npm run dev`，打开 http://localhost:5173 用 `admin / admin` 登录
（详见前端仓 README）。群详情右上角的「模拟外部发言」能以外部成员身份往群里推消息、触发 Agent（`.env.example` 里
`SIM_CONTROLS_ENABLED=1` 已打开，见下文「演示：模拟外部成员发言」）。

**重启了网关模拟器，就要连库一起重置**：模拟器默认只在内存里记状态，事件编号从 1 重新开始，而后端把见过的编号记在库里，
新事件会被当成重复推送丢掉。做法见 [docs/manual-testing.md](docs/manual-testing.md)「0.2 每轮测试前重置」；
不想每次重置就在 .env 里给 `SIM_GATEWAY_STATE_FILE` 设一个文件名（例如 .gateway-sim.json），模拟器重启就不丢状态。

### 环境变量

`.env.example` 是本地开发的完整模板；`src/core/config.ts` 是唯一读取处，启动时一次性校验，缺必填项直接启动失败。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串（带用户名） |
| `JWT_SECRET` | 必填 | access token（HS256）签名密钥，≥ 32 字符 |
| `PORT` | 3000 | 后端监听端口（`.env.example` 与部署都用 8000） |
| `GATEWAY_URL` | 必填 | 消息网关地址；本地是模拟器 `http://localhost:8100` |
| `AGENT_URL` | 必填 | Agent 服务地址：模拟器 `http://localhost:8200`，或真实 LLM 版 `http://localhost:8300` |
| `SIM_CONTROLS_ENABLED` | 0 | 1 = 控制台可「模拟外部发言」（经网关模拟器 `/_sim/push`）；只在网关是模拟器时打开 |
| `COOKIE_SECURE` | 生产 1、其余 0 | refresh cookie 是否带 `Secure`；站点只有 http 时设 0 |
| `AGENT_TURN_TIMEOUT_MS` | 12000 | 每轮等 `/agent/turn` 的时间，只能在 10000–15000（题目 A5） |
| `AGENT_AUDIT_TIMEOUT_MS` | 5000 | 等 `/agent/audit` 的时间 |
| `MEDIA_DIR` / `MEDIA_RETENTION_DAYS` | `media` / 30 | 媒体文件（题目 C1）的存放目录与保留天数 |
| `MEDIA_MAX_BYTES` | 10485760 | 单个媒体文件的大小上限，超过的不下载（记 `MEDIA_TOO_LARGE`） |
| `CORS_ORIGINS` | 不设（不开 CORS） | 允许跨域调用的来源，逗号分隔；控制台走同源反代，用不到 |
| `LLM_AGENT_ADMIN_TOKEN` 等 | — | 真实 LLM 版 Agent 的配置，见下文「接入真实 LLM」 |
| `SIM_GATEWAY_PORT` / `SIM_AGENT_PORT` | 8100 / 8200 | 两个模拟器的端口 |
| `SIM_GATEWAY_STATE_FILE` | 不设（纯内存） | 网关模拟器的状态文件：设了则重启不丢账号、群与事件历史（Docker Compose 部署设在 `gateway-data` 卷） |

### 常见问题

- **启动报「数据库 schema 落后于代码 / 比代码新」**：启动门禁发现库的迁移记录与本地 `prisma/migrations/` 对不上。
  落后：`npm run db:deploy` 或直接重启（启动时会自动前滚）；比代码新：代码版本比库旧（切回了旧分支 / 回滚部署），换回新代码或重建库。
- **控制台里外部消息不出现、Agent 不触发**：多半是只重启了网关模拟器没重置库，见上面「重启了网关模拟器」。
- **登录报「登录失败次数过多」（429）**：同一用户名 10 分钟内失败 5 次会锁 1 分钟，等提示的秒数后再试。
- **`npm test` 报没有 DATABASE_URL**：测试不读 .env，见下文「测试」。

## 部署（Docker Compose / Dokploy）

`docker-compose.yml` 一次起后端、两个模拟器与真实 LLM 版 Agent；数据库用单独的 PostgreSQL（Dokploy 里单独建一个 Database 服务），
`DATABASE_URL` 填它的内网连接串。前端是另一个独立部署的 nginx 镜像。步骤、环境变量、重置数据与用完后彻底清理见
[docs/deploy.md](docs/deploy.md)；变量模板是 [.env.deploy.example](.env.deploy.example)。

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

## 演示：模拟外部成员发言

题目里「外部用户在群里发言」发生在网关那一侧；本地与演示环境的网关都是模拟器，用它的 `/_sim/push` 推。
`SIM_CONTROLS_ENABLED=1` 时后端代为调用（仅 admin），控制台群详情右上角的「模拟外部发言」就是它：

```bash
curl -s localhost:8000/api/sim-controls -H "$H"                              # { "enabled": true }
curl -s localhost:8000/api/groups/<id>/simulate-inbound -H "$H" -H 'content-type: application/json' \
  -d '{"senderPlatformUserId":"ext-alice","text":"请问活动几点开始？"}'        # 202；消息经事件流进入时间线
```

群开着 `agentEnabled` 时会随之触发一次 agent run。不经后端、直接打模拟器也行：
`curl -s -X POST localhost:8100/_sim/push -H 'content-type: application/json' -d '{"kind":"message","groupId":"<网关群 ID>","senderPlatformUserId":"ext-alice","text":"hi"}'`。

## 复现题目 2.4 的典型场景

网关与 Agent 模拟器都有 `/_sim/scenario`、`/_sim/state`、`/_sim/reset` 管理端点；S1–S8 各自怎么配写在
[src/sim/gateway/README.md](src/sim/gateway/README.md)（网关侧）与 [src/sim/agent/scenario.ts](src/sim/agent/scenario.ts)
（Agent 剧本 DSL）。例如让每个事件推两次（S2）：

```bash
curl -s localhost:8100/_sim/scenario -H 'content-type: application/json' -d '{"events":{"duplicates":2}}'
```

自动化版本：`tests/scenarios-m1.test.ts`（S1–S4）、`tests/scenarios-m2.test.ts`（S5、S6 经 SSE 触发的全链路）、
`tests/sequences*.test.ts`（S7、S8），以及 `tests/recovery-m1.test.ts` / `tests/agent-run.test.ts` 里在各个「缝」上停机再启动的恢复用例。

## 接入真实 LLM（题目 C2）

`src/llm-agent/` 是一个独立的 Agent 服务：对外接口与题目 2.2 完全相同，上游只支持题目点名的 **Claude** 与 **Gemini**，
分别用官方 SDK（`@anthropic-ai/sdk`、`@google/genai`）调官方端点。服务商、API Key、模型**只在 Web 控制台的「模型设置」里配**
（选服务商、填 Key → 获取模型列表 → 选模型 → 保存 → 测试连接），保存后立即生效、重启后仍在。设计（两家的协议映射、
思考状态按 runId 回传、配置与 key 的处理、失败语义、超时预算）见 [src/llm-agent/README.md](src/llm-agent/README.md)。

```bash
# .env：AGENT_URL=http://localhost:8300，LLM_AGENT_ADMIN_TOKEN=<随机长串>（后端与 llm-agent 读同一份 .env）
npm run llm-agent               # 代替 npm run sim:agent，http://localhost:8300
npm run dev                     # 后端照常；控制台的模型设置经后端 /api/llm/* 代理到 llm-agent
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_AGENT_ADMIN_TOKEN` | llm-agent 必填 | 管理端点的令牌，后端与 llm-agent 配同一个值；后端没配时控制台显示「不支持」 |
| `LLM_AGENT_CONFIG_FILE` | 启动目录下的 .llm-agent.json | 控制台保存的配置（含 key，chmod 600，不进 git / 镜像），相对启动目录；同目录的 .llm-agent-sessions/ 存按 runId 的思考状态 |
| `LLM_TIMEOUT_MS` | 10000 | 一次 turn 调上游的总预算（含重试），须小于后端 `AGENT_TURN_TIMEOUT_MS` |
| `LLM_AGENT_PORT` | 8300 | 监听端口 |

`AGENT_URL` 仍指向 Agent 模拟器时，控制台的模型设置显示「不支持」（`supported: false`），其余功能照常。
从更早版本升级时，旧的 .llm-agent.json 格式不再被接受（`LLM_CONFIG_INVALID`）：在控制台带上 API Key 重新保存一次即可覆盖。

**两家的要点**（2026-09-30 按官方文档核实；模型会更新，以控制台「获取模型列表」为准，列表只列本服务用得上的模型）：

| | Claude | Gemini |
| --- | --- | --- |
| Key | Claude Console 的 API key，请求头 `x-api-key` | Google AI Studio 的 API key，请求头 `x-goog-api-key` |
| 模型列表 | Models API；只留 adaptive 思考、`low` effort、结构化输出都支持的模型 | `models.list`；只留支持 `generateContent` 的模型 |
| 工具调用 | tools / messages 直通；`tool_choice` 只用 `auto`（当前模型拒绝强制调用），一次最多一个 tool_use | `functionDeclarations`（`parametersJsonSchema`）+ `AUTO`；多个 functionCall 只取第一个 |
| 思考 | adaptive、effort `low`（当前模型思考关不掉）；思考块按 runId 原样回传 | Gemini 3 设 `thinkingLevel: LOW`；`thoughtSignature` 按 runId 原样回传 |
| 审计 | 结构化输出 `output_config.format`（JSON schema） | `responseMimeType: "application/json"` + `responseJsonSchema` |
| 拒绝 | `stop_reason: "refusal"` → end_turn；Opus 5.5 / Opus 5 / Sonnet 5.5 / Fable 5.1 默认开服务端拒绝兜底 `fallbacks: "default"` | 安全拦截（`blockReason` / `finishReason`）→ end_turn |

**超时关系**：后端每轮等 `/agent/turn` 的时间是 `AGENT_TURN_TIMEOUT_MS`（默认 12000，题目允许 10–15 秒），等
`/agent/audit` 是 `AGENT_AUDIT_TIMEOUT_MS`（默认 5000）；llm-agent 调上游的总预算（`LLM_TIMEOUT_MS`、审计固定 4000）
要各小 1–2 秒，让它在后端放弃之前自己回 502 / 500。模型慢（「测试连接」返回的 `latencyMs` 接近 `LLM_TIMEOUT_MS`）时两边一起调大，
例如 `AGENT_TURN_TIMEOUT_MS=15000` + `LLM_TIMEOUT_MS=13000`；再慢就换更快的模型 —— run 另有 60 秒总预算，单轮太慢步数就不够用了。

## 媒体文件（题目 C1）

`message` 事件带 `mediaUrl` 时，后端的 media worker 把文件下载到 `MEDIA_DIR`（默认 `media/`），路径记在消息的
`localFilePath`；只下载网关自己的地址，网关 404（已过期）即放弃。超过 `MEDIA_RETENTION_DAYS`（默认 30）天的文件每小时
清理一次：先清记录、再删文件，所在群有运行中的 agent run 的跳过。部署时 `MEDIA_DIR` 放在持久卷上
（`docker-compose.yml` 的 `media-data`），否则重新部署文件就没了；真丢了也不会留下指向不存在文件的记录，清理步骤会
对账并重新下载。

## 测试

全部跑真实 PostgreSQL：每个测试文件在 `DATABASE_URL` 所在库里建一个临时 schema、跑迁移链、结束后删掉；
外部服务用本仓模拟器起在随机端口；不 mock 数据库、禁外网。

```bash
set -a; . ./.env; set +a        # 测试不读 .env：把 DATABASE_URL 带进环境（或单独设 TEST_DATABASE_URL，优先用它）
npm test                        # 全量约 2 分钟（2026-09-30 实测）
npm run test:coverage           # CI 跑这个；行覆盖率地板见 vitest.config.mts
```

CI 在干净的 Postgres 上跑：`tsc --noEmit`、`npm run lint`、`npm run format:check`、迁移链从零前滚（`prisma migrate deploy`）、
`npm run test:coverage` 与 `npm run build`。

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
src/llm-agent/  真实 LLM 版 Agent 服务（题目 C2，独立进程，上游 Claude / Gemini 官方 SDK）
prisma/         schema 与迁移（部分唯一索引、CHECK 约束手写在迁移里）
tests/          vitest（真库）
```

三条贯穿全局的设计：外部副作用一律走 outbox（先落库再发，504 后按 clientMsgId 确认没发出才重发一次）；
入站按 at-least-once 处理（eventId / (groupId, msgId) 去重，游标只越过已确认没有更小 id 在途的事件，
处理失败按退避自动重试）；互斥与预算靠数据库
（部分唯一索引保证同群单 run / 单序列，预算按落库时间戳累计，停机不计）。
