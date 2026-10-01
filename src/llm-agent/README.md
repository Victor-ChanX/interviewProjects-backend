# llm-agent：真实 LLM 版 Agent 服务（题目 C2）

一个独立进程，对外接口与题目 2.2 完全相同（`POST /agent/turn`、`POST /agent/audit`），后端只改 `AGENT_URL`
就能从模拟器（`src/sim/agent`）切过来。上游只有题目点名的两家，都用官方 SDK 调官方端点：

- **Claude**：`@anthropic-ai/sdk`，Messages API（`https://api.anthropic.com`）
- **Gemini**：`@google/genai`，Gemini Developer API 的 `generateContent`（`https://generativelanguage.googleapis.com`）

服务商、API Key、模型**只**在 Web 控制台的「模型设置」里配，保存进配置文件；没有环境变量这条路，也没有端点地址可配。
启动方式见仓库根 README「接入真实 LLM（题目 C2）」。

## 文件

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 进程入口：缺 `LLM_AGENT_ADMIN_TOKEN` 报错退出、预算自检告警、建两家客户端、listen `LLM_AGENT_PORT`（默认 8300） |
| `app.ts` | `buildLlmAgentApp({ clients, store, sessions, settings, adminToken })`：2.2 两个端点 + `/admin/*` + 错误信封 + 会话状态的读写 |
| `protocol.ts` | 纯函数：2.2 的请求校验与类型、恰好一个块的响应、审计结论的 JSON schema 与严格解析 |
| `upstream.ts` | 两家客户端的共同接口 `LlmClient`（turn / audit / listModels）与 `UpstreamError` |
| `anthropic.ts` | Claude：请求直通、思考块回传、响应映射、结构化输出审计、Models API |
| `gemini.ts` | Gemini：tools / messages ↔ functionDeclarations / contents、thoughtSignature 回传、结构化输出审计、模型列表 |
| `session-store.ts` | 按 runId 记住上游返回的完整 assistant 回合（落盘，有上限） |
| `config-store.ts` | 配置文件读写（每个请求重新读；写入 600 + 原子 rename）、key 提示与抹除 |
| `prompts.ts` | 中文系统提示词（turn / audit 各一份） |

地位与 `src/sim/*` 相同：不 import `src/db`、`src/services`，只用 `src/core` 的 config / logger / clock。

## 配置：只来自控制台

控制台 → 后端 `/api/llm/*`（`src/api/routes/llm-settings.ts`，admin 才能写）→ 本服务 `/admin/*`（请求头
`x-admin-token` = `LLM_AGENT_ADMIN_TOKEN`，后端与本服务配同一个值）。

| 端点 | 作用 |
| --- | --- |
| `GET /admin/config` | `{ provider, model, auditModel, hasApiKey, apiKeyHint, updatedAt, source }`，`provider ∈ anthropic / gemini`，`source ∈ file / none` |
| `PUT /admin/config` | 保存 `{ provider, apiKey?, model, auditModel? }` 到 `LLM_AGENT_CONFIG_FILE`（默认启动目录下的 `.llm-agent.json`） |
| `POST /admin/models` | `{ provider, apiKey? }` → `{ items: [{ id, displayName }], total }`，顺序同服务商返回 |
| `POST /admin/test` | 用已保存的配置跑一轮**带工具调用历史**的对话 + 一次审计，返回 `{ ok, latencyMs, model, message }` |

- **key 只进不出**：响应里只有 `hasApiKey` 与 `apiKeyHint`（前 3 后 4），日志不记 key；上游报错进响应 / 日志前
  一律把 key 换成 `***`。配置文件 chmod 600，`.gitignore` 与 `.dockerignore` 都排除它。
- **`apiKey` 省略**：只有 `provider` 与已保存的相同时才沿用已存的 key，否则 422 `LLM_API_KEY_REQUIRED` ——
  一家的 key 不会被发到另一家。
- **SDK 不读环境变量**：两家 SDK 在没收到参数时会从环境变量取 key、端点（Gemini 还会按环境变量切到 Vertex AI），
  本服务把 key、端点、`authToken: null` / `vertexai: false` 都显式传进去，环境里有什么都不影响。
- **立即生效**：`/agent/turn`、`/agent/audit` 每次请求都重新读配置文件，保存后不用重启。
- **模型列表只列用得上的**：Claude 走 Models API（`client.models.list()`，自动翻页），只留 `capabilities` 里
  adaptive 思考、`low` effort、结构化输出都支持的模型；Gemini 走 `models.list`，只留 `supportedGenerationMethods`
  （SDK 里叫 `supportedActions`）含 `generateContent` 的，id 去掉 `models/` 前缀。
- **未配置**：`/agent/turn`、`/agent/audit` 回 503 `LLM_NOT_CONFIGURED`；后端分别记为协议错误 / 审计拿不到结论。
- **配置文件格式不对**（例如更早版本留下的文件）：`/agent/*` 与 `GET /admin/config` 回 500 `LLM_CONFIG_INVALID`，
  文案说明怎么修；在控制台带着 API Key 重新保存一次即可覆盖（带 key 的保存不读旧文件）。

## /agent/turn：Claude

2.2 的请求本身就是 Anthropic tool use 形状，所以 `tools`（`input_schema` 原样）与 `messages` 直通，加系统提示词。
参数按 Anthropic 官方 TypeScript SDK 文档与模型迁移指南定：

| 参数 | 值 | 依据 |
| --- | --- | --- |
| `tool_choice` | `{ type: "auto", disable_parallel_tool_use: true }` | 当前模型（Claude Opus 5.5 等）拒绝强制工具调用（`any` / `tool` 返回 400）；`disable_parallel_tool_use` 使一次最多一个 tool_use |
| `thinking` | `{ type: "adaptive" }` | 当前模型思考关不掉（`disabled` 返回 400），effort 是唯一的控制 |
| `output_config.effort` | `"low"` | 群聊短回复、每轮只有 `LLM_TIMEOUT_MS` 预算；文档建议对话 / 简单任务用 `low` |
| `max_tokens` | 16000 | 文档对非流式请求的默认建议；思考也计入 `max_tokens`，给小了会截断 |
| `cache_control` | `{ type: "ephemeral" }`（顶层自动缓存） | 同一个 run 的历史只追加，前缀每轮都能命中 |
| `fallbacks` | `"default"`（beta `server-side-fallback-2026-07-01`） | 见下「拒绝兜底」 |

**响应 → 恰好一个块**：`stop_reason: "refusal"` → `end_turn`，text 写明模型拒绝（带 `stop_details.category`）；
content 里有 `tool_use` 取第一个 → `stop_reason: "tool_use"`（若同时 `stop_reason: "max_tokens"`，入参可能被截断，回 502）；
否则把 text 块拼起来 → `end_turn`（空时给默认 summary）。思考块不出现在给后端的响应里。

**拒绝兜底（refusal fallbacks）**：文档要求对 `claude-fable-5-1`、`claude-opus-5-5`、`claude-opus-5`、`claude-sonnet-5-5`
默认开启服务端 `fallbacks: "default"`：安全分类器拒绝时，API 在同一次调用里按拒绝类别改用 Anthropic 推荐的备用模型作答，
不用自己维护模型名（`reasoning_extraction` 类不兜底）。其他模型不带这个参数。备用模型作答时 content 开头有一个
`fallback` 标记块，本服务只记它之后的内容；备用模型读不了原模型的思考块，API 会静默丢弃（不计费），请求照常成功。

## /agent/turn：Gemini

- `tools` → `config.tools[0].functionDeclarations`（`input_schema` 原样作 `parametersJsonSchema`），
  `toolConfig.functionCallingConfig.mode = AUTO`，系统提示词放 `config.systemInstruction`。
- `messages` → `contents`：user 的 text → `{ role: "user", parts: [{ text }] }`；assistant 的 tool_use →
  `{ role: "model", parts: [{ functionCall: { id, name, args } }] }`；user 的 tool_result →
  `{ functionResponse: { id?, name, response } }`（name 按 tool_use_id 从历史里找；`is_error` 时结果放 `error` 键，否则 `output` 键，
  API 参考写明失败用 `error` 键）；相邻 user 内容合并成一条，functionResponse 在前。
- Gemini 3 系列设 `thinkingConfig.thinkingLevel = LOW`（SDK 官方 codegen 说明：Gemini 3 用 thinkingLevel），其他模型用默认。
- **响应 → 恰好一个块**：有 `functionCall` part 取第一个（id 用上游给的；没有或与历史重复就生成）；
  `promptFeedback.blockReason` 或 `finishReason` 为 SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT / SPII / LANGUAGE
  → `end_turn` 写明模型拒绝；`MALFORMED_FUNCTION_CALL` 或没有候选 → 502；否则拼非思考（`thought !== true`）的 text → `end_turn`。

## 触发消息里的图片（后端 #61）

题目 2.2 的 tool_result 有 8KB 上限，放不下图片字节，所以平台把触发消息中已下载的图片（题目 C1）以
`{ type: "image", msgId, source: { type: "base64", media_type, data } }` 块跟在第一条 user 消息的上下文 text 后面
（每轮最多 4 张；附件还在下载时平台先等最多 8 秒）。这里原样转给上游：Claude 是 image 块，Gemini 是 `inlineData`
part。请求体上限因此放到 16 MB。`get_recent_messages` 里带附件的消息多一个 `hasAttachment: true`（只是标记）。

## 思考状态回传（按 runId 的会话状态）

2.2 每轮只回一个块，思考内容没有位置，后端传回来的历史里只剩 `tool_use`。两家都要求多轮工具调用把思考状态原样带回：

- **Claude**：思考块要原样回传；preserved thinking 规则下，中途删掉一个思考块会让它之后的思考块全部失效
  （2026-08-31 起创建的账号直接 400），从最前面删一段则允许，全部去掉也允许（文档给的恢复方式就是去掉思考块、保留 text 与 tool_use）。
- **Gemini 3**：`functionCall` part 上的 `thoughtSignature` 必须原样放回，当前轮任一步缺了直接 400；确实拿不到签名时
  文档允许把它设为 `skip_thought_signature_validator`（最后手段，会降低效果）。

题目 2.2 允许「Agent 服务按 runId 维护会话状态」，所以本服务每轮把上游返回的**完整** assistant 回合（Claude：到第一个
tool_use 为止的 content 块；Gemini：到第一个 functionCall 为止的 model Content）按 `runId` + `tool_use.id` 记下来
（`session-store.ts`），下一轮后端传回同一个 tool_use 时，发给上游前换成记住的完整内容。只认同一服务商、同一模型记下的。

**记不到时**（该轮响应被后端判了超时 / 协议错误没进历史、记忆被上限挤掉、换了模型）：

- Claude：前面连续记不到的轮次只发 tool_use（等于从最前面删思考块，允许）；已经开始回传之后再遇到记不到的，从那一轮起
  都只发 tool_use、不再回传思考块（等于去掉那个块及之后的全部思考块，允许）。所以请求不会因此 400，只是模型少了那几轮的
  推理上下文。
- Gemini：那一步的 functionCall 用 `skip_thought_signature_validator` 作签名，请求不会 400。

**存放与上限**：配置文件同目录的 `.llm-agent-sessions/`（目录 700、文件 600，已被 `.gitignore` / `.dockerignore` 排除），
一个 run 一个文件（文件名是 runId 的 sha256）。每个 run 最多记 24 轮（超出丢最早的，对 Claude 正是允许的「从最前面删」）；
目录里最多 200 个 run、超过 24 小时没动过的删掉；run 以 `finish` 或 `end_turn` 结束时立即删。落盘是为了本服务重启、
或后端在 run 中途重启后恢复时，同一个 run 还能接着回传。同一个 run 两轮重叠（极少：后端单 runner）时后写覆盖先写，
丢的那一轮按记不到处理。

## /agent/audit

审核提示词 + 结构化输出，模型只能给出 `{ verdict: "pass" | "fail", reason: string }`：

- Claude：`output_config.format = { type: "json_schema", schema }`（adaptive 思考 + low effort，`max_tokens` 4096），
  同样按上面的名单开拒绝兜底。
- Gemini：`responseMimeType: "application/json"` + `responseJsonSchema`（API 参考里 `responseSchema` 已标为 deprecated）。

拿不到明确结论（上游失败、超时、被拒绝、被截断、输出不是这个形状）一律 500 `AUDIT_UNAVAILABLE`：后端对同一次工具调用
最多重试 3 次，都拿不到就把 run 置 `blocked`。不做宽松解析（不剥代码围栏、不从正文里抠 JSON），也不把拿不到结论降级成 pass 或 fail。

## 失败语义（沿用 2.2）

| 情况 | 本服务的响应 | 后端怎么处理 |
| --- | --- | --- |
| 还没在控制台配置 | `503 LLM_NOT_CONFIGURED` | turn 记 `BAD_JSON`；audit 按拿不到结论重试，最终 `blocked` |
| `/agent/turn` 上游超时 / 重试后仍 429、5xx / 连不上 / 4xx / 输出不可用 | `502 UPSTREAM_ERROR`（带 `upstreamStatus`） | 记 `BAD_JSON` 协议错误，追加 `PROTOCOL_ERROR` 文本继续；连续 3 次结束 run |
| `/agent/audit` 拿不到结论 | `500 AUDIT_UNAVAILABLE` | 同一次工具调用最多重试 3 次，都拿不到 → run `blocked` |
| tools 不是规定的 4 个 / required 不全 | `400 TOOLS_INVALID` | 同模拟器 |
| 管理端点：上游拒绝 key（401 / 403；Gemini 对无效 key 回的是 400 + `ErrorInfo.reason = API_KEY_INVALID`，同样算） | `422 LLM_UPSTREAM_UNAUTHORIZED` | 后端原样转给控制台 |
| 管理端点：上游其他失败 | `502 LLM_UPSTREAM_ERROR` | 同上 |

## 超时预算

每次调上游有一个**总**预算（含 SDK 的重试与退避）：turn 用 `LLM_TIMEOUT_MS`（默认 10s），audit 用 `app.ts` 的
`AUDIT_TIMEOUT_MS`（4s）。实现上把 `AbortSignal.timeout(预算)` 交给 SDK：Claude SDK 的重试等待也会被它中止；Gemini SDK
的重试等待不受它中止，但间隔上限设为 1 秒，最多超出预算约 1 秒，下一次尝试会立即被中止。它们必须分别小于后端的 `AGENT_TURN_TIMEOUT_MS`
（默认 12s）与 `AGENT_AUDIT_TIMEOUT_MS`（默认 5s），启动时不满足会打告警。重试交给 SDK，最多 2 次：Claude SDK 重试 408 / 409 / 429 / 5xx
与连接失败，Gemini SDK 重试 408 / 429 / 500 / 502 / 503 / 504；401 / 403 / 400 不重试。

## 测试

`tests/llm-agent.test.ts`（两家的 turn / audit、会话状态回传、失败映射、管理端点、全链路）与 `tests/llm-settings.test.ts`
（后端代理）。上游是 `tests/fake-anthropic.ts` 与 `tests/fake-gemini.ts` 两个假服务（listen(0)），SDK 经一个只给测试替身用的
内部构造选项指过去 —— 控制台与配置文件里没有这个选项。
