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

## 接入真实 LLM（题目 C2）

`src/llm-agent/` 是一个独立的 Agent 服务：对外接口与题目 2.2 完全相同，上游走 OpenAI Chat Completions 兼容格式。
上游的 Base URL / API Key / 模型**只在 Web 控制台的「模型设置」里配**（填 Base URL 与 Key → 获取模型列表 → 选模型 → 保存 →
测试连接），保存后立即生效、重启后仍在。设计（协议转换、配置与 key 的处理、失败语义、超时预算、思考类模型）见
[src/llm-agent/README.md](src/llm-agent/README.md)。

```bash
# .env：AGENT_URL=http://localhost:8300，LLM_AGENT_ADMIN_TOKEN=<随机长串>（后端与 llm-agent 读同一份 .env）
npm run llm-agent               # 代替 npm run sim:agent，http://localhost:8300
npm run dev                     # 后端照常；控制台的模型设置经后端 /api/llm/* 代理到 llm-agent
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_AGENT_ADMIN_TOKEN` | llm-agent 必填 | 管理端点的令牌，后端与 llm-agent 配同一个值；后端没配时控制台显示「不支持」 |
| `LLM_AGENT_CONFIG_FILE` | 启动目录下的 .llm-agent.json | 控制台保存的配置（含 key，chmod 600，不进 git / 镜像），相对启动目录 |
| `LLM_TIMEOUT_MS` | 10000 | 一次 turn 调上游的总预算（含重试），须小于后端 `AGENT_TURN_TIMEOUT_MS` |
| `LLM_AGENT_PORT` | 8300 | 监听端口 |

`AGENT_URL` 仍指向 Agent 模拟器时，控制台的模型设置显示「不支持」（`supported: false`），其余功能照常。
审计请求恒带 `response_format: {"type":"json_object"}`；个别服务商不支持时，「测试连接」会把失败原因报出来。

**服务商示例**（2026-09-30 按官方文档核实；模型名会更新，以控制台「获取模型列表」和出处为准）。本服务不回传
`reasoning_content`，所以对能关思考的服务商自动关掉（`src/llm-agent/providers.ts`），关不掉又要求回传的模型不能用。

| 服务商 | Base URL | 模型 | 备注 | 出处 |
| --- | --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro` | 思考默认开启，本服务自动关；带 tools 时不回传 `reasoning_content` 会 400 | [models](https://api-docs.deepseek.com/quick_start/pricing)、[thinking](https://api-docs.deepseek.com/guides/thinking_mode) |
| Kimi（Moonshot） | `https://api.moonshot.ai/v1` | `kimi-k2.6` | 只有 `kimi-k2.6` 能关思考（本服务自动关）；`kimi-k3`、`kimi-k2.7-code` 始终思考且要求回传思考内容，不能用 | [thinking](https://platform.kimi.ai/docs/guide/use-thinking-models)、[API](https://platform.kimi.ai/docs/api/chat) |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-flash`、`mimo-v2.6-pro` | 思考默认开启，本服务自动关；`tool_choice` 只认 `auto`（本服务就发 `auto`）；JSON 模式未能从文档确认，以「测试连接」为准 | [OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | 见服务商文档（示例用 `gemini-3.8-flash`） | 文档写明 2.5 Pro 与 3 系列不能关思考；3 系列在兼容端点上的 thought signature 回传规则未核实，多轮工具调用以「测试连接」为准 | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |

**超时关系**：后端每轮等 `/agent/turn` 的时间是 `AGENT_TURN_TIMEOUT_MS`（默认 12000，题目允许 10–15 秒），等
`/agent/audit` 是 `AGENT_AUDIT_TIMEOUT_MS`（默认 5000）；llm-agent 调上游的总预算（`LLM_TIMEOUT_MS`、审计固定 4000）
要各小 1–2 秒，让它在后端放弃之前自己回 502 / 500。模型慢（「测试连接」返回的 `latencyMs` 接近 `LLM_TIMEOUT_MS`）时两边一起调大，
例如 `AGENT_TURN_TIMEOUT_MS=15000` + `LLM_TIMEOUT_MS=13000`；再慢就换更快的模型 —— run 另有 60 秒总预算，单轮太慢步数就不够用了。

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
src/llm-agent/  真实 LLM 版 Agent 服务（题目 C2，独立进程，OpenAI 兼容上游）
prisma/         schema 与迁移（部分唯一索引、CHECK 约束手写在迁移里）
tests/          vitest（真库）
```

三条贯穿全局的设计：外部副作用一律走 outbox（先落库再发，504 后按 clientMsgId 确认没发出才重发一次）；
入站按 at-least-once 处理（eventId / (groupId, msgId) 去重，游标落库）；互斥与预算靠数据库
（部分唯一索引保证同群单 run / 单序列，预算按落库时间戳累计，停机不计）。
