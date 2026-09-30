// 场景脚本：网关模拟器的全部「可脚本化行为」都在这一个对象里，由 POST /_sim/scenario 打补丁
// （按节浅合并：传 `{ send: { responses: [...] } }` 只改 send.responses，其余保持），POST /_sim/reset 恢复默认。
// 默认值即题目 2.1 的「通常」行为（join 100–1500ms、send 事件 50–2000ms、kick 1–5s、每个事件推一次、不乱序）。
import { z } from "zod";

/** 延时范围：写一个数等于 { min, max } 相同（固定延时）。 */
const rangeSchema = z
  .union([
    z.number().int().min(0),
    z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }),
  ])
  .transform((r) => (typeof r === "number" ? { min: r, max: r } : r));

export type Range = { min: number; max: number };

/** send 的脚本化响应只对匹配的调用生效（都不填 = 匹配任何一次 send）。 */
const matchSchema = z
  .object({
    accountId: z.string().optional(),
    clientMsgId: z.string().optional(),
  })
  .optional();

/**
 * send 的固定响应序列：每次 send 消耗队首（匹配的）一条，队列空了走默认行为。
 * 带状态副作用的条目与题目同义：429 让账号进入限流期；ACCOUNT_SUSPENDED / SESSION_EXPIRED 让账号
 * 永久进入该状态（之后该账号所有请求都得到同样的错误，并被移出所有群）；GROUP_WRITE_FORBIDDEN 让该群
 * 永久不可写；504 可选 `landAfterMs`（消息在 N ms 后落地并推 message_sent，null = 没发出）。
 */
const sendResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal(202), match: matchSchema }),
  z.object({
    status: z.literal(429),
    retryAfterSeconds: z.number().int().min(1),
    match: matchSchema,
  }),
  z.object({
    status: z.literal(403),
    code: z.enum([
      "ACCOUNT_SUSPENDED",
      "GROUP_WRITE_FORBIDDEN",
      "SENDER_NOT_IN_GROUP",
    ]),
    /** ACCOUNT_SUSPENDED 时是否再推一条 account_status（题目：不保证） */
    pushStatusEvent: z.boolean().default(true),
    match: matchSchema,
  }),
  z.object({
    status: z.literal(401),
    pushStatusEvent: z.boolean().default(true),
    match: matchSchema,
  }),
  z.object({ status: z.literal(409), match: matchSchema }),
  z.object({
    status: z.literal(504),
    landAfterMs: z.number().int().min(0).nullable().default(null),
    match: matchSchema,
  }),
  z.object({ status: z.literal(503), match: matchSchema }),
]);

export type SendResponse = z.output<typeof sendResponseSchema>;

const outageSchema = z.object({
  /** 所有非 /_sim 端点整体 503 */
  all: z.boolean(),
  /** 只让部分端点 503：按 "<METHOD> <路由模板>" 子串匹配，例如 "by-client-id"、"POST /groups" */
  routes: z.array(z.string()),
});

const eventsSchema = z.object({
  /** 每个事件推几次（at-least-once；2 = 每个事件推两次） */
  duplicates: z.number().int().min(1).max(5),
  /** 乱序窗口：每次投递随机延迟 0–N ms（≤ 1000），相邻事件因此可能乱序 */
  reorderWindowMs: z.number().int().min(0).max(1000),
  /** 每条 SSE 连接写了 N 帧后主动掐断（null = 不掐） */
  disconnectAfterFrames: z.number().int().min(1).nullable(),
});

const inviteSchema = z.object({
  /** 邀请链接多久后可用（题目：可能 0，也可能几秒） */
  readyAfterMs: rangeSchema,
  /** 链接申请后多久过期（null = 不过期；随时过期用 POST /_sim/invites/expire） */
  expiresAfterMs: z.number().int().min(0).nullable(),
});

const joinSchema = z.object({
  /** 202 之后多久推 member_joined */
  delayMs: rangeSchema,
  /** true = 受理后永远不推 member_joined（账号并未入群） */
  neverJoin: z.boolean(),
});

const kickSchema = z.object({
  /** kick 的响应延迟（题目：1–5 秒） */
  responseDelayMs: rangeSchema,
  /**
   * 非 null 时 kick 返回 504 NETWORK_TIMEOUT：`removed` 决定目标最终是否被移除，
   * `convergeAfterMs` 是移除落地（成员列表变化 + member_left）的时刻（题目：2 秒内收敛）。
   */
  timeout: z
    .object({
      removed: z.boolean(),
      convergeAfterMs: z.number().int().min(0).max(2000),
    })
    .nullable(),
});

const leaveSchema = z.object({
  /** true = 所有 leave 返回 500（没退成） */
  fail: z.boolean(),
  /** 只让这些 accountId 的 leave 返回 500（其余照常）；与 fail 任一命中即 500 */
  failAccountIds: z.array(z.string()),
});

const sendSchema = z.object({
  /** 202 本身的响应延迟（题目：可能要一两秒） */
  acceptDelayMs: rangeSchema,
  /** 202 之后多久推 message_sent / message_failed */
  eventDelayMs: rangeSchema,
  /** 受理后的结果：落地推 message_sent，或推 message_failed { code } */
  outcome: z.enum([
    "sent",
    "failed:GROUP_WRITE_FORBIDDEN",
    "failed:ACCOUNT_SUSPENDED",
  ]),
  /** 服务账号自己发出的消息是否也作为 message 事件推回来（题目：会） */
  echoOwnMessage: z.boolean(),
  /** 固定响应序列，见 sendResponseSchema */
  responses: z.array(sendResponseSchema),
});

const groupsSchema = z.object({
  /** 这些群不可写（send → 403 GROUP_WRITE_FORBIDDEN） */
  writeForbidden: z.array(z.string()),
});

const sections = {
  outage: outageSchema,
  events: eventsSchema,
  invite: inviteSchema,
  join: joinSchema,
  kick: kickSchema,
  leave: leaveSchema,
  send: sendSchema,
  groups: groupsSchema,
};

export const scenarioSchema = z.object(sections);
export type Scenario = z.output<typeof scenarioSchema>;

export const scenarioPatchSchema = z.object({
  outage: outageSchema.partial().optional(),
  events: eventsSchema.partial().optional(),
  invite: inviteSchema.partial().optional(),
  join: joinSchema.partial().optional(),
  kick: kickSchema.partial().optional(),
  leave: leaveSchema.partial().optional(),
  send: sendSchema.partial().optional(),
  groups: groupsSchema.partial().optional(),
});
export type ScenarioPatch = z.output<typeof scenarioPatchSchema>;

export function defaultScenario(): Scenario {
  return {
    outage: { all: false, routes: [] },
    events: { duplicates: 1, reorderWindowMs: 0, disconnectAfterFrames: null },
    invite: { readyAfterMs: { min: 0, max: 0 }, expiresAfterMs: null },
    join: { delayMs: { min: 100, max: 1500 }, neverJoin: false },
    kick: { responseDelayMs: { min: 1000, max: 5000 }, timeout: null },
    leave: { fail: false, failAccountIds: [] },
    send: {
      acceptDelayMs: { min: 0, max: 0 },
      eventDelayMs: { min: 50, max: 2000 },
      outcome: "sent",
      echoOwnMessage: true,
      responses: [],
    },
    groups: { writeForbidden: [] },
  };
}

/** 按节浅合并：补丁里出现的节只覆盖写了的字段；数组整体替换。 */
export function applyScenarioPatch(
  current: Scenario,
  patch: ScenarioPatch,
): Scenario {
  return {
    outage: { ...current.outage, ...patch.outage },
    events: { ...current.events, ...patch.events },
    invite: { ...current.invite, ...patch.invite },
    join: { ...current.join, ...patch.join },
    kick: { ...current.kick, ...patch.kick },
    leave: { ...current.leave, ...patch.leave },
    send: { ...current.send, ...patch.send },
    groups: { ...current.groups, ...patch.groups },
  };
}
