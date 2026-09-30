# llm-agent：真实 LLM 版 Agent 服务（题目 C2）

一个独立进程，对外接口与题目 2.2 完全相同（`POST /agent/turn`、`POST /agent/audit`），后端只改 `AGENT_URL`
就能从模拟器（`src/sim/agent`）切过来。上游走 **OpenAI Chat Completions 兼容格式**（`POST {baseUrl}/chat/completions`，
`Authorization: Bearer {apiKey}`）。上游的 Base URL / API Key / 模型**只**在 Web 控制台的「模型设置」里配，
保存进配置文件；没有环境变量这条路。启动与服务商示例见仓库根 README「接入真实 LLM（题目 C2）」。

## 文件

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 进程入口：缺 `LLM_AGENT_ADMIN_TOKEN` 报错退出、预算自检告警、listen `LLM_AGENT_PORT`（默认 8300） |
| `app.ts` | `buildLlmAgentApp({ upstream, store, settings, adminToken })`：2.2 两个端点 + `/admin/*` + 错误信封 |
| `config-store.ts` | 配置文件读写（每个请求重新读；写入 600 + 原子 rename）、key 提示与抹除 |
| `openai-client.ts` | 上游 HTTP：`chat`（总时长预算、429 / 5xx 有界重试）、`listModels` |
| `translate.ts` | 纯函数：请求校验、Anthropic ↔ OpenAI 两个方向的转换、审计输出解析 |
| `providers.ts` | 服务商差异：按主机名 + 模型名给请求体加参数（关思考），附官方文档出处 |
| `prompts.ts` | 中文系统提示词（turn / audit 各一份） |
| `audit.ts` | `/agent/audit`：审核提示词 + `response_format: json_object`（被拒则去掉重试一次）→ `{ verdict, reason }` |

地位与 `src/sim/*` 相同：不 import `src/db`、`src/services`，只用 `src/core` 的 config / logger / clock。
不存会话状态 —— 后端每轮都传完整历史，`runId` 只进日志。

## 配置：只来自控制台

控制台 → 后端 `/api/llm/*`（`src/api/routes/llm-settings.ts`，admin 才能写）→ 本服务 `/admin/*`（请求头
`x-admin-token` = `LLM_AGENT_ADMIN_TOKEN`，后端与本服务配同一个值）。

| 端点 | 作用 |
| --- | --- |
| `GET /admin/config` | `{ baseUrl, model, auditModel, hasApiKey, apiKeyHint, updatedAt, source }`，`source ∈ file / none` |
| `PUT /admin/config` | 保存 `{ baseUrl, apiKey?, model, auditModel? }` 到 `LLM_AGENT_CONFIG_FILE`（默认仓库根 `.llm-agent.json`） |
| `POST /admin/models` | 调 `{baseUrl}/models`，返回 `{ models: [{ id, ownedBy }] }`（按 id 排序） |
| `POST /admin/test` | 用已保存的配置跑一轮**带工具调用历史**的对话 + 一次审计，返回 `{ ok, latencyMs, model, message }` |

- **key 只进不出**：响应里只有 `hasApiKey` 与 `apiKeyHint`（前 3 后 4），日志不记 key；上游报错可能回显 key，
  进响应 / 日志前一律换成 `***`。配置文件 chmod 600，`.gitignore` 与 `.dockerignore` 都排除它。
- **`apiKey` 省略**：只有 `baseUrl` 与已保存的相同时才沿用已存的 key，否则 422 `LLM_API_KEY_REQUIRED` ——
  防止把已存的 key 发给另一个主机。
- **立即生效**：`/agent/turn`、`/agent/audit` 每次请求都重新读配置文件，保存后不用重启；重启后照样读回。
- **未配置**：`/agent/turn`、`/agent/audit` 回 503 `LLM_NOT_CONFIGURED`（「请先在控制台『模型设置』里配置」）；
  后端分别记为协议错误 / 审计拿不到结论，这是 2.2 的既有语义。
- 为什么「测试连接」要带工具历史：真实的第二轮就是这个形状，要求回传思考内容的
  服务商会在这里直接报出来，而不是等到 agent run 里连续协议错误。

## 协议转换

**请求（Anthropic → OpenAI）**

- `tools[]` → `{ type: "function", function: { name, description, parameters: input_schema } }`，`tool_choice: "auto"`；
  不发 `parallel_tool_calls`（有的服务商不认），也不发 `temperature`（用服务商默认值，部分思考模型只接受默认值）。
- 最前面加系统提示词（`prompts.ts`）：身份、触发上下文各字段的含义、只能通过工具行动、每条新消息用新的
  `idempotency_key`（重试同一条才复用）、不回复 `ownPlatformUserIds`、`autoKickEnabled=false` 时不踢人、回复简短、必须 `finish`。
- user 的 text 块 → user 消息（第一条是触发上下文 JSON 串，原样给模型；`PROTOCOL_ERROR …` 也走这里）。相邻 user 文本合并成一条。
- assistant 的 tool_use 块 → `tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }]`，
  `content: null`（OpenAI 规范允许、官方 SDK 回放时也是 null；空串在个别服务商会被判为空消息）。
- user 的 tool_result 块 → `{ role: "tool", tool_call_id, content }`；`is_error` 时 content 前加「工具调用失败（is_error=true）」。
  配不上前一条 tool_calls 的结果降级成 user 文本，没收到结果的 tool_call 补一条占位 tool 消息 —— 防上游 400。

**响应（OpenAI → Anthropic，每轮恰好一个块）**

- `tool_calls` 非空 → 只取**第一个** → `stop_reason: "tool_use"`。
- `id` 缺失或与历史里的 tool_use.id 重复 → 生成新 id（后端会把重复 id 判为 `DUPLICATE_TOOL_USE_ID`）。
- `arguments` 不是合法 JSON → 仍返回 tool_use，`input: {}`：后端按 input_schema 判 `INVALID_INPUT` 并把缺哪个字段回灌，
  模型下一轮能自纠；返回 5xx 的话模型只会看到一句笼统的协议错误。
- 无 tool_calls → `stop_reason: "end_turn"`，text 为 `message.content`（空时给默认 summary）。
- 思考类模型的 `reasoning_content` 丢弃，不回传（2.2 的块里没有它的位置）。

**失败语义（沿用 2.2）**

| 情况 | 本服务的响应 | 后端怎么处理 |
| --- | --- | --- |
| 还没在控制台配置 | `503 LLM_NOT_CONFIGURED` | turn 记 `BAD_JSON`；audit 按拿不到结论重试，最终 `blocked` |
| `/agent/turn` 上游超时 / 重试后仍 429、5xx / 连不上 / 响应不是 chat completion | `502 UPSTREAM_ERROR` | 记 `BAD_JSON` 协议错误，追加 `PROTOCOL_ERROR` 文本继续；连续 3 次结束 run |
| `/agent/audit` 上游失败，或模型输出解析不出 `pass` / `fail` | `500 AUDIT_UNAVAILABLE` | 同一次工具调用最多重试 3 次，都拿不到 → run `blocked` |
| tools 不是规定的 4 个 / required 不全 | `400 TOOLS_INVALID` | 同模拟器 |

审计解析对**模型**宽容（剥一层 markdown 代码围栏），对**后端**严格（本服务的响应永远是合法 JSON）。解析失败不降级成 pass 或 fail。

## 超时预算

`openai-client.ts` 的每次调用有一个**总**预算（含重试与退避）：turn 用 `LLM_TIMEOUT_MS`（默认 10s），audit 用
`app.ts` 的 `AUDIT_TIMEOUT_MS`（4s）。它们必须分别小于后端的 `AGENT_TURN_TIMEOUT_MS`（默认 12s）与 `AGENT_AUDIT_TIMEOUT_MS`（默认 5s）：
后端到点就放弃并丢弃之后到达的响应，本服务要在那之前自己收手回 502 / 500，而不是在后端放弃后还在花 token 重试。
启动时不满足会打告警（两个进程通常共用同一份 .env）。只重试 408 / 429 / 5xx / 连接失败，最多 2 次，
指数退避并尊重 `Retry-After`，剩余预算不够一次尝试就停。

## 思考类模型

本服务不存状态，拿不到上一轮的 `reasoning_content`。DeepSeek 文档写明：思考模式下请求带 tools 时不回传它会返回 400。
所以 `providers.ts` 对**能关思考**的服务商自动在请求体里关掉（DeepSeek、小米 MiMo、Kimi 的 `kimi-k2.6`），
关不掉又要求回传的模型（Kimi 的 `kimi-k3` / `kimi-k2.7-code`）不支持 —— 「测试连接」会报出来。

## 测试

`tests/llm-agent.test.ts`（翻译 / 失败 / 审计 / 未配置 / 管理端点 / 全链路）与 `tests/llm-settings.test.ts`（后端代理），
上游都是 `tests/fake-openai.ts` 的假 OpenAI 服务。
