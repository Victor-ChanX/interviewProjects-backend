# 人工测试手册

把整套服务在本机跑起来，用浏览器（控制台）加几条命令，逐项验证题目要求的行为。每个用例都写了**对应条款**、**步骤**、**预期**和**在哪里看**。

控制台负责「看」和「运营操作」；外部世界的动作（外部用户在群里发言、网关故障、账号被平台停用）由**网关模拟器**的管理接口触发，Agent 的各种坏行为由 **Agent 模拟器**的剧本触发。模拟器接口的完整说明见 [src/sim/gateway/README.md](../src/sim/gateway/README.md) 与 [src/sim/agent/scenario.ts](../src/sim/agent/scenario.ts)。

## 0. 准备

### 0.1 启动

前提：Node ≥ 22.18、本机 PostgreSQL、`jq`。后端仓 `.env` 至少包含：

```bash
PORT=8000
DATABASE_URL=postgres://<user>@localhost:5432/interview_backend
JWT_SECRET=<任意 32 位以上字符串>
GATEWAY_URL=http://localhost:8100
AGENT_URL=http://localhost:8200          # 用 Agent 模拟器；接真实模型时改成 8300，见第 11 节
LLM_AGENT_ADMIN_TOKEN=<任意随机串>        # 只有接真实模型时需要
```

开 4 个终端：

```bash
# 后端仓
npm run sim:gateway                                   # 网关模拟器 :8100
npm run sim:agent                                     # Agent 模拟器 :8200
set -a; . ./.env; set +a; npm run dev                 # 后端 :8000（启动时自动迁移 + 种子）

# 前端仓
VITE_API_PROXY=http://localhost:8000 npm run dev      # 控制台 http://localhost:5173
```

### 0.2 每轮测试前重置

网关模拟器的状态在内存里，重启后事件编号从 1 重新开始；而后端把见过的事件编号记在库里，新事件会被当成重复推送丢掉。**所以网关模拟器和数据库必须一起重置**：

```bash
# 停掉后端，然后：
psql -d postgres -c 'DROP DATABASE IF EXISTS interview_backend WITH (FORCE)' -c 'CREATE DATABASE interview_backend'
curl -s -X POST localhost:8100/_sim/reset       # 网关模拟器清空
curl -s -X POST localhost:8200/_sim/reset       # Agent 模拟器清空
# 再启动后端
```

### 0.3 常用命令

后面的命令都假设设置了这几个变量（在控制台群详情页可以看到「网关群 ID」）：

```bash
GW=http://localhost:8100
AG=http://localhost:8200
G=<网关群 ID，如 g_5ffed3d96722>
```

- 查网关里到底发生了什么（用来确认「网关里恰好一条消息」「到期前网关没收到 send」）：`curl -s $GW/_sim/state | jq '{messages: [.messages[] | {text, clientMsgId}], sendCalls}'`
- 场景恢复默认：`curl -s -X POST $GW/_sim/scenario -H 'content-type: application/json' -d '{"send":{"responses":[]},"events":{"duplicates":1,"reorderWindowMs":0}}'`

### 0.4 账号

| 用户名 | 密码 | 权限 |
| --- | --- | --- |
| admin | admin | 全部权限 |
| viewer | viewer | 只读 |

预置服务账号 `acc-1` … `acc-5`，初始都是「空闲」。

---

## 1. 登录、权限与会话（A0、B3）

| # | 步骤 | 预期 |
| --- | --- | --- |
| 1.1 | 打开控制台，用 admin 登录 | 进入工作台；右上角实时连接显示「实时」 |
| 1.2 | 退出，用 viewer 登录，逐个打开账号、群组、模型设置页 | 所有写操作按钮（重连、标记离线、新建群、发送、开关、保存……）都不出现 |
| 1.3 | viewer 直接调写接口：`curl -s -X POST localhost:8000/api/accounts/acc-1/connect -H "Authorization: Bearer <viewer 的 token>"` | `403`，`error.code = FORBIDDEN` |
| 1.4 | 登录后打开浏览器开发者工具 → Application → Session Storage，删掉 access token，刷新页面 | 不跳登录页，页面照常加载（用 refresh cookie 静默续期） |
| 1.5 | 点「退出」后，用刚才的 access token 调任意接口 | `401`（退出后 token 立即失效） |

## 2. 账号状态机（A1）

| # | 步骤 | 预期 / 在哪看 |
| --- | --- | --- |
| 2.1 | 账号管理页：acc-1、acc-2、acc-3 点「重连」 | 变「在线」并显示平台用户 ID；按钮变成「标记离线」「释放账号」（只显示当前状态下合法的转移） |
| 2.2 | acc-3 点「标记离线」，再点「重连」 | 在线 → 已离线 → 在线（「离线」页签里也能筛出它）；每次状态变化实时生效，不用刷新 |
| 2.3 | **并发冲突**：开两个浏览器标签打开账号页，都停在 acc-2「在线」；标签 A 点「标记离线」，标签 B 点「释放账号」 | 只有一个成功；另一个提示「状态已变化」并刷新列表（`409 CAS_CONFLICT`） |
| 2.4 | **终态级联**（需要先有群，见第 3 节）：`curl -s -X POST $GW/_sim/push -H 'content-type: application/json' -d '{"kind":"account_status","accountId":"acc-3","status":"suspended"}'` | 账号页 acc-3 变「已停用（终态）」且没有任何按钮；群详情里 acc-3 从成员中消失；工作台 / 实时动态出现「账号被停用」 |
| 2.5 | 对 acc-3 再推一次同样的事件 | 什么都不变（重复进入同一终态静默忽略） |

## 3. 建群与退群（A3、B2）

| # | 步骤 | 预期 / 在哪看 |
| --- | --- | --- |
| 3.1 | 群组管理页「新建群」：群主 acc-1，成员 acc-2、acc-3 | 对话框显示建群进度，几秒内完成并跳到群详情；成员：acc-1 群主、acc-2 管理员（第一个成员被提升）、acc-3 成员 |
| 3.2 | **邀请链接未就绪**：`curl -s -X POST $GW/_sim/scenario -H 'content-type: application/json' -d '{"invite":{"readyAfterMs":3000}}'`，再新建一个群 | 进度会停在邀请步骤约 3 秒，然后成功 |
| 3.3 | **入群事件永远不来**：`-d '{"invite":{"readyAfterMs":0},"join":{"neverJoin":true}}'`，再新建群 | 约 10 秒后任务失败，错误里有 `join:<账号>` / `JOIN_TIMEOUT`。测完改回 `{"join":{"neverJoin":false}}` |
| 3.4 | 在 3.1 的群点「全部退群」 | 进度依次退非群主账号，最后退群主；完成后群状态「已退出」，成员为空；`curl -s $GW/_sim/state \| jq '.leaveCalls'` 里群主是最后一个 |
| 3.5 | **某成员退不掉**：新建一个群，`-d '{"leave":{"failAccountIds":["acc-2"]}}'`，点「全部退群」 | 任务失败，错误含 `leave:acc-2`；acc-3 照常退出，**群主不退**；群详情里 acc-1、acc-2 仍是成员 |

## 4. 消息时间线（A2、A4、S1–S3）

先用 3.1 的方法建一个群，并把网关群 ID 设为 `$G`。

| # | 步骤 | 预期 / 在哪看 |
| --- | --- | --- |
| 4.1 | **S1 受理与发出**：`-d '{"send":{"eventDelayMs":3000}}'`，然后在群详情用 acc-2 发一条消息 | 气泡状态依次：排队中 → 已受理（约 3 秒）→ 已发送；始终只有一行 |
| 4.2 | **外部用户发言**：`curl -s -X POST $GW/_sim/push -H 'content-type: application/json' -d "{\"kind\":\"message\",\"groupId\":\"$G\",\"senderPlatformUserId\":\"ext-alice\",\"text\":\"请问活动几点开始？\"}"` | 1–2 秒内出现在时间线左侧，不用刷新 |
| 4.3 | **S2 事件重复**：`-d '{"events":{"duplicates":2}}'`，再推一条外部消息、再发一条自己的消息 | 时间线各只多一行（后端按 `(群, msgId)` 去重） |
| 4.4 | **S3 自己的消息回流**：观察 4.1 / 4.3 自己发的消息 | 网关把它作为 `message` 事件推回来，时间线仍只有一行，显示为自己的消息（右侧）；开启 Agent 时也不会触发 run（见 6.6） |
| 4.5 | **乱序**：`-d '{"events":{"duplicates":1,"reorderWindowMs":1000}}'`，连续推 5 条外部消息 | 时间线按发送时间排序 |
| 4.6 | **加载更早**：用循环推 60 条外部消息 `for i in $(seq 1 60); do curl -s -X POST $GW/_sim/push -H 'content-type: application/json' -d "{\"kind\":\"message\",\"groupId\":\"$G\",\"senderPlatformUserId\":\"ext-bob\",\"text\":\"第 $i 条\"}" >/dev/null; done`，刷新群详情，点「加载更早」 | 每页 50 条，翻页不重复不遗漏；翻页的同时再推几条新消息，新消息追加在底部，老页不受影响 |

## 5. 网关错误处理（A2 错误表、S4、S5）

| # | 场景 | 步骤 | 预期 / 在哪看 |
| --- | --- | --- | --- |
| 5.1 | **S4 限流** | `-d '{"send":{"responses":[{"status":429,"retryAfterSeconds":20,"match":{"accountId":"acc-2"}}]}}'`，然后用 acc-2 连发 3 条 | 账号页 acc-2 变「限流中」并显示到期时间；3 条消息都是「排队中」；20 秒内 `/_sim/state` 的 `sendCalls` 里 acc-2 只有第一次 429；到期后自动回「在线」，3 条按顺序发出 |
| 5.2 | **504 结果未知、其实已送达**（S5 的网关部分） | `-d '{"send":{"responses":[{"status":504,"landAfterMs":1500}]}}'`，发一条 | 状态短暂「状态未知」，约 2 秒内变「已发送」；`/_sim/state` 的 `messages` 里这条**恰好一条**（没有重发） |
| 5.3 | **504 且确实没发出** | `-d '{"send":{"responses":[{"status":504,"landAfterMs":null}]}}'`，发一条 | 「状态未知」→ 确认没发出后用同一个 clientMsgId 重发一次 → 已发送；网关里恰好一条 |
| 5.4 | **504 两次都没发出** | `-d '{"send":{"responses":[{"status":504,"landAfterMs":null},{"status":504,"landAfterMs":null}]}}'`，发一条 | 最终「发送失败」，原因 `NETWORK_TIMEOUT`；网关里没有这条 |
| 5.5 | **群不可写** | `-d "{\"groups\":{\"writeForbidden\":[\"$G\"]}}"`，发一条 | 这条「发送失败 GROUP_WRITE_FORBIDDEN」；群状态变「不可写」；该群进行中的序列变「已停止」，Agent 不再触发 |
| 5.6 | **账号被停用（发送时发现）** | `-d '{"send":{"responses":[{"status":403,"code":"ACCOUNT_SUSPENDED","match":{"accountId":"acc-3"}}]}}'`，用 acc-3 发一条 | acc-3 变「已停用（终态）」，从所有群移除；它排队中的消息变「已取消 ACCOUNT_TERMINAL」 |
| 5.7 | **离线账号发送** | 账号页把 acc-2 标记离线，再到群详情用 acc-2 发 | 弹出提示「账号不可用」（`409 ACCOUNT_UNAVAILABLE`），不会发到网关 |
| 5.8 | **事件流断开** | `curl -s -X POST $GW/_sim/streams/disconnect`，紧接着推 2 条外部消息 | 后端自动重连并带 `since` 补拉，2 条都出现、不重复 |
| 5.9 | **后端停机期间的事件** | 停掉后端 → 推 3 条外部消息、再推一个 `member_joined`（`{"kind":"member_joined","groupId":"$G","platformUserId":"ext-carol"}`）→ 启动后端 | 3 条消息与新成员都出现（停机期间的事件恢复后全部处理） |

## 6. Agent 接入（A5、S5、S6）——用 Agent 模拟器

群详情打开「Agent 自动回复」。Agent 模拟器默认剧本：读最近消息 → 发一条消息 → 结束。

| # | 步骤 | 预期 / 在哪看 |
| --- | --- | --- |
| 6.1 | 推一条外部消息（4.2 的命令） | 群详情「Agent 运行」出现一条，几秒后「已完成」；时间线出现 Agent 发的回复；点进运行详情：3 步（`get_recent_messages`、`send_message` 审计「通过」、`finish`） |
| 6.2 | **S5 同一个 key 重试**：网关 `-d '{"send":{"responses":[{"status":504,"landAfterMs":1500}]}}'`；Agent：`curl -s -X POST $AG/_sim/scenario -H 'content-type: application/json' -d '{"turn":{"steps":[{"type":"get_recent_messages","limit":10},{"type":"send_message","text":"收到"},{"type":"send_message","text":"收到","reuse_key":true}],"fallback":"finish"}}'`；再推一条外部消息 | 网关里这条回复**恰好一条**；运行详情第 3 步（同 key 的 send_message）结果是那条消息当前状态「已发送」，且**没有审计结论**（第二次不再审计）；run 正常结束 |
| 6.3 | **S6 坏响应**：`-d '{"turn":{"steps":[{"type":"invalid_json"},{"type":"unknown_tool"}],"fallback":"finish"}}'`，推一条外部消息 | run 以「已完成」结束；详情里第 1 步是「协议错误 BAD_JSON」，可展开看原始响应体；第 2 步是 `UNKNOWN_TOOL` 错误；服务不崩 |
| 6.4 | **连续 3 次协议错误**：`-d '{"turn":{"steps":[{"type":"invalid_json","repeat":3}],"fallback":"finish"}}'` | run「失败」，结束原因 `protocol_errors` |
| 6.5 | **步数上限**：`-d '{"turn":{"steps":[],"fallback":"loop_tools"}}'` | 12 步后「失败」，结束原因 `budget_exhausted` |
| 6.6 | **自己的消息不触发**：Agent 开着时用 acc-2 手动发一条 | 不产生新的 run |
| 6.7 | **审计拒绝**：`-d '{"audit":{"steps":[],"fallback":{"mode":"fail","reason":"含敏感词"}}}'`（turn 恢复默认），推外部消息 | send_message 那步错误 `AUDIT_REJECTED`，消息没发出 |
| 6.8 | **审计拿不到结论**：`-d '{"audit":{"steps":[],"fallback":{"mode":"http_500"}}}'` | run「被拦下」（blocked），在群详情与工作台醒目标红；审计重试 3 次（`$AG/_sim/state` 的 audits） |
| 6.9 | **踢人需开关**：`-d '{"turn":{"steps":[{"type":"kick_user","platform_user_id":"ext-alice"}],"fallback":"finish"}}'`，自动踢人关着时推外部消息；再打开「自动踢人」重来 | 关：`POLICY_DENIED`，没踢；开：ext-alice 从成员中消失 |
| 6.10 | **run 期间的新消息合并**：`-d '{"turn":{"steps":[{"type":"get_recent_messages","limit":10,"delay_ms":5000}],"fallback":"finish"}}'`，连推 3 条外部消息 | 第一条触发 run；运行中的两条在它结束后合并进**下一个** run 的触发消息（详情页可见）；同一时刻只有一个运行中 |
| 6.11 | **关闭 Agent 取消运行中的 run**：同 6.10 的慢剧本，run 运行中关掉「Agent 自动回复」 | 当前步结束后 run「已取消」 |
| 6.12 | **重启恢复**：`-d '{"turn":{"steps":[{"type":"get_recent_messages","limit":10},{"type":"send_message","text":"重启测试"},{"type":"get_recent_messages","limit":10,"delay_ms":10000}],"fallback":"finish"}}'`，推外部消息；时间线出现「重启测试」、run 仍显示运行中（在等第 3 轮的慢响应）时停掉后端，再启动 | run 用同一个 ID 继续跑完（已完成）；「重启测试」这条消息网关里恰好一条（`/_sim/state` 的 messages），没有因为重启再发一次 |

## 7. 定时序列（B1、S7、S8）

| # | 步骤 | 预期 / 在哪看 |
| --- | --- | --- |
| 7.1 | 定时序列页点「新建序列」：第 1 步 admin「`{event} 将于 {time} 开始，请提前准备`」延迟 5 秒；第 2 步 member「`提醒：{event} 的资料已上传到 {location}`」延迟 5 秒，点「创建序列」 | 列表里出现这个序列 |
| 7.2 | **S8 预检失败**：在定时序列页这一行点「在群启动」→ 选群（进入该群的序列运行页，序列已选好），只填 `vars`：`event`、`time`，不填 `location`，点预检 | 预检弹窗把第 2 步的 `location` 标红，启动按钮不可点；直接调接口得 `422 UNRESOLVED_PLACEHOLDER`，`stepIndex = 2`、`key = location`；网关收不到任何消息 |
| 7.3 | `stepVars` 第 2 步填 `location = 共享盘/第二季度`，再预检 | 每步每个 key 的取值与来源（`default` / `step:2`）；启动后第 1 步约 5 秒后由管理员账号发出，第 2 步在第 1 步**发出后**再过 5 秒由成员账号发出；进度实时变化 |
| 7.4 | **S7 并发启动**：同一群、同一序列，同时发两次启动请求（`curl ... & curl ... & wait`） | 恰好一个 `201`、一个 `409 SEQUENCE_ALREADY_RUNNING` |
| 7.5 | **没有匹配账号**：把群里 member 角色的账号都标记离线再启动 | member 那步「已跳过」并有时间戳，序列继续推进 |
| 7.6 | **限流顺延**：启动前按 5.1 让 admin 账号限流 | admin 那步不跳过，等限流结束后再发 |
| 7.7 | **重启后不一次性全发**：启动一个 3 步、每步 30 秒的序列，第 1 步发出后停掉后端 2 分钟再启动 | 只重排最早一个过期步骤（重启时刻 + 该步延迟），后续步骤仍按「前一步发出后」排 |

## 8. 断线补齐（B4）

| # | 步骤 | 预期 |
| --- | --- | --- |
| 8.1 | 打开群详情，开发者工具 Network 切到 Offline（或停掉后端）；期间推 3 条外部消息；恢复网络（或启动后端） | 右上角显示「重连中」→「同步中」→「实时」；3 秒内 3 条消息出现，不重复 |

## 9. 异常中心（A2「让操作员看到」）

| # | 步骤 | 预期 |
| --- | --- | --- |
| 9.1 | 推一条本地不存在的群的消息：`curl -s -X POST $GW/_sim/push -H 'content-type: application/json' -d '{"kind":"raw","type":"message","data":{"groupId":"g_unknown","msgId":"m_x","senderPlatformUserId":"ext-x","text":"hi","sentAt":"2026-01-01T00:00:00.000Z"}}'` | 异常中心出现一条「未知群」异常（实时推送，菜单上未处理数 +1）；事件流不中断，后续消息照常 |
| 9.2 | admin 点「标记已处理」 | 移到「已处理」，记录处理人 |

## 10. 工作台

完成上面任意几节后打开工作台：指标卡（账号、群组、今日消息、Agent 运行、序列、待处理异常）与实际一致；「需要处理」里能看到被拦下的 run、失败 / 状态未知的消息、未处理异常；「实时动态」随操作逐条滚动。

## 11. 接入真实模型（C2）

1. `.env` 设 `AGENT_URL=http://localhost:8300` 与 `LLM_AGENT_ADMIN_TOKEN`，另开终端 `npm run llm-agent`，重启后端。
2. 控制台「模型设置」：选服务商（Claude / Gemini）→ 填 API Key → 获取模型列表 → 选对话模型 → 保存 → 测试连接（显示延迟与结果）。
3. 群详情打开「Agent 自动回复」，推一条外部消息（4.2）。
4. 预期：run 完成；时间线里出现模型生成的回复；运行详情可见每一步的工具调用与审计结论。
5. 切回模拟器：`AGENT_URL` 改回 8200 并重启后端；模型设置页会提示当前服务不支持在线配置。
