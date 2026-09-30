# 消息网关模拟器（题目 2.1）

独立进程：`npm run sim:gateway`（端口 `SIM_GATEWAY_PORT`，默认 8100）。测试里用 `buildGatewayApp({ logger: false })` + `app.inject`，
SSE 用真实 `listen(0)`。它是「外部服务」：不 import 应用的 `src/db` / `src/services`，状态只在内存里；
可注入时钟（`clock`，`src/core/clock.ts` 的 `Clock`）与随机源（`random: () => number`，[0, 1)）。

## 响应形状

- 成功体按题目原样：`{ platformUserId }`、`{ groupId }`、`{ inviteLink, readyAfterMs }`、`202 { accepted: true }`、
  `200 {}`（promote / leave / disconnect）、`200 { kicked: true }`、成员列表是裸数组 `[{ platformUserId }]`、
  by-client-id `{ msgId, sentAt }`。
- 错误体统一 `{ code, message, ...extra }`（`errors.ts`），例如 `409 { code: "ACCOUNT_OFFLINE" }`、
  `429 { code: "RATE_LIMITED", retryAfterSeconds }`。题目没写、模拟器自定的码：`404 GROUP_NOT_FOUND`、
  `409 NOT_IN_GROUP`（kick 的目标 / leave 的账号不在群里）、`400 BAD_REQUEST`、`404 NOT_FOUND`（by-client-id、media、未知路径）、
  `503 SERVICE_UNAVAILABLE`、`500 INTERNAL`。
- 建群的创建者也要求在线（离线 → `409 ACCOUNT_OFFLINE`）：题目只列了 send / join / promote / kick / leave，
  但离线账号不可能「在响应返回时即为成员」。

## 公开端点（被应用调用的）

| 端点 | 行为 |
| --- | --- |
| `POST /accounts/:accountId/connect` | `{ platformUserId }`，同一 accountId 永远同一个值（accountId 的哈希）。终态账号 → 403 / 401 |
| `POST /accounts/:accountId/disconnect` | 账号离线；之后 send / join / promote / kick / leave → `409 ACCOUNT_OFFLINE` |
| `POST /groups { creatorAccountId }` | `{ groupId }`，创建者即群主与成员，不推 member_joined |
| `POST /groups/:groupId/invite` | `{ inviteLink, readyAfterMs }`（场景 `invite`） |
| `POST /groups/:groupId/join { accountId, inviteLink }` | `202 { accepted: true }`；`join.delayMs` 后成员列表先变、再推 member_joined；`409 ALREADY_MEMBER` / `409 INVITE_NOT_READY` / `410 INVITE_EXPIRED` |
| `POST /groups/:groupId/promote { byAccountId, accountId }` | `200 {}`，不推事件；`403 NO_PERMISSION` / `409 NOT_MEMBER_YET` |
| `POST /groups/:groupId/kick { byAccountId, targetPlatformUserId }` | 先移除、`kick.responseDelayMs` 后 `200 { kicked: true }`、响应之后推 member_left；`409 OWNER_LEFT` / `403 NO_PERMISSION`；场景 `kick.timeout` → `504 NETWORK_TIMEOUT` |
| `POST /groups/:groupId/leave { accountId }` | `200 {}` 后推 member_left；场景 `leave.fail` → 500（没退成） |
| `GET /groups/:groupId/members` | `[{ platformUserId }]` |
| `POST /groups/:groupId/send { accountId, clientMsgId, text }` | 见下；不按 clientMsgId 去重 |
| `GET /groups/:groupId/messages/by-client-id/:clientMsgId` | `200 { msgId, sentAt }`（最早一条）/ 404 |
| `GET /media/:id` | 文件字节；过期 / 不存在 404 |
| `GET /events?since=<eventId>` | SSE，见下 |

send 的检查顺序：账号终态（403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED）→ 限流（429，计时重置）→ 离线（409）→
群不存在（404）→ 群不可写（403 GROUP_WRITE_FORBIDDEN）→ 不在群（403 SENDER_NOT_IN_GROUP）→ 场景 `send.responses` 队首 →
`send.acceptDelayMs` 后 `202`，再 `send.eventDelayMs` 后按 `send.outcome` 推 `message_sent { clientMsgId, msgId, sentAt }`
（并按 `echoOwnMessage` 把同一 msgId 作为 `message` 事件回流）或 `message_failed { clientMsgId, code }`。

SSE 帧：`id: <eventId>` / `event: <type>` / `data: <JSON>`，data 里带 `eventId` 与 `type`。eventId 从 1 全局递增，
历史全部保留；`since` 独占、按序回放后接实时；不带 since 只收连接之后的。at-least-once 与乱序由场景 `events` 控制，
只作用于实时投递（回放不重复、不乱序）。

## 管理端点（`/_sim/*`，不受 503 开关影响）

| 端点 | 用途 |
| --- | --- |
| `GET /_sim/scenario` | 当前场景 |
| `POST /_sim/scenario <补丁>` | 按节浅合并（`{ send: { responses: [...] } }` 只改这一项；数组整体替换），返回完整场景；非法 → 400 |
| `POST /_sim/reset` | 清空账号 / 群 / 消息 / 事件 / 定时器，场景恢复默认，掐断所有 SSE，eventId 从 1 重新开始 |
| `GET /_sim/state` | `accounts` / `groups`（members、pendingJoins、ownerLeft、writeForbidden）/ `invites` / `messages` / `sendCalls`（每次 send 的状态码）/ `promoteCalls`（每次 promote 的状态码与错误码）/ `events { count, lastEventId, byType, items }` / `streams.open` / `pendingTimers` |
| `POST /_sim/push` | 手动推事件，返回 `{ eventIds }`：`{ kind: "message", groupId, text, senderPlatformUserId?, sentAt?, media?: { contentType, base64, expiresAfterMs? } }`（外部用户消息，可带 mediaUrl）、`{ kind: "member_joined" \| "member_left", groupId, platformUserId }`（外部用户进出群）、`{ kind: "account_status", accountId, status }`（停用 / 失效：移出所有群 + member_left + account_status）、`{ kind: "redeliver", msgId }`（离线补投：新 eventId、原 msgId / sentAt）、`{ kind: "raw", type, data }` |
| `POST /_sim/streams/disconnect` | 掐断所有 SSE 连接 |
| `POST /_sim/invites/expire { inviteLink? }` | 让某条（或全部）邀请链接立刻过期 |

场景字段与默认值见 `scenario.ts`（`defaultScenario()`）。延时字段写一个数 = 固定，写 `{ min, max }` = 随机。

## 典型场景怎么配（题目 2.4）

| # | 网关侧表现 | `POST /_sim/scenario` |
| --- | --- | --- |
| S1 | send 先 202，过一会儿再推 message_sent | 默认即是；要固定延时：`{ "send": { "eventDelayMs": 800 } }`；202 本身慢：`"acceptDelayMs": 1500` |
| S2 | 每个事件推两次 | `{ "events": { "duplicates": 2 } }`；乱序再加 `"reorderWindowMs": 1000` |
| S3 | 自己发的消息作为 message 事件推回 | 默认即是（`send.echoOwnMessage: true`），msgId 与 message_sent 相同 |
| S4 | send 回 429 RATE_LIMITED { retryAfterSeconds: N } | `{ "send": { "responses": [{ "status": 429, "retryAfterSeconds": 5, "match": { "accountId": "<id>" } }] } }`；期内该账号每次 send 都 429 且计时重置，`GET /_sim/state` 的 `sendCalls` 可断言「到期前网关收不到 send」 |
| S5 | 第一次 send 回 504、1.5 秒后落地 | `{ "send": { "responses": [{ "status": 504, "landAfterMs": 1500 }] } }`；之后 `state.messages` 恰好一条、by-client-id 200。没发出：`"landAfterMs": null` |
| S6 | —（Agent 服务的场景） | 网关默认即可 |
| S7 | —（应用自身并发） | 网关默认即可 |
| S8 | 网关收不到任何消息 | 默认；用 `GET /_sim/state` 的 `sendCalls` / `messages` 为空断言 |

其他契约条款对应的开关：

- 邀请：`{ "invite": { "readyAfterMs": 3000, "expiresAfterMs": 10000 } }`；随时过期 `POST /_sim/invites/expire`。
- join 永不到：`{ "join": { "neverJoin": true } }`（A2 的 JOIN_TIMEOUT）。
- kick 慢 / 超时：`{ "kick": { "responseDelayMs": { "min": 1000, "max": 5000 } } }`；
  `{ "kick": { "timeout": { "removed": true, "convergeAfterMs": 1500 } } }`（504，1.5s 后成员列表变化 + member_left）。
- leave 没退成：`{ "leave": { "fail": true } }`。
- 账号停用 / 失效（同步错误形式）：`{ "send": { "responses": [{ "status": 403, "code": "ACCOUNT_SUSPENDED", "pushStatusEvent": false }] } }`、
  `[{ "status": 401 }]`；事件形式：`POST /_sim/push { "kind": "account_status", ... }`。
- 群不可写：`{ "groups": { "writeForbidden": ["<groupId>"] } }` 或 `send.outcome: "failed:GROUP_WRITE_FORBIDDEN"`（message_failed）。
- 整体 503：`{ "outage": { "all": true } }`；只让 by-client-id 不可用：`{ "outage": { "routes": ["by-client-id"] } }`。
- 连接断开：`{ "events": { "disconnectAfterFrames": 10 } }` 或 `POST /_sim/streams/disconnect`。
