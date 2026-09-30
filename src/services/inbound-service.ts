// 入站事件（题目 2.1 事件流 + A2 入站条款，issue #8）：一条 SSE 帧怎么变成库里的状态。
//
// 三层去重 / 容错，各管一件事：
// 1. **事件级**：inbound_events.eventId 唯一。同一事件推两次（S2）第二次 create 撞 P2002 → 跳过，不处理。
//    例外：行在、但 processedAt 为空且 attempts = 0 —— 进程死在「插入」与「处理」之间，游标没推进，网关重推
//    时补处理（这是 at-least-once 下唯一会出现这种行的路径）。
// 2. **消息级**：messages 的 (groupId, msgId) 唯一。补投 / 乱序带来的同一条消息用新 eventId 再来时，
//    createMany({ skipDuplicates }) 是 ON CONFLICT DO NOTHING —— 不抛错、不写第二行、不再发 ws 事件
//    （agent 触发点 #12 读 ws_events，所以这里不发它就不会被重复触发）。
// 3. **处理失败不中断**：先插入 inbound_events（独立提交）→ 在一个 $transaction 里处理 + 写 processedAt。
//    处理抛错 → 事务回滚，但 inbound_events 行还在（原文不丢）；随后另起事务写 attempts + 1 / lastError、
//    一行 inconsistencies { kind: inbound_event_failed, ref: eventId } 与 ws_events inconsistency，
//    调用方（worker）继续下一条。ingest 本身只在「连记失败都记不下来」（库不可用）时才抛。
//
// 游标 event_cursor.lastEventId 由 worker 在每条 ingest 之后 advanceCursor：只在 eventId 更大时推进
// （乱序窗口 ≤ 1s 里先到的可能是更大的 id；先推到大的，再来小的不能把游标拉回去，否则重连会重放一段 ——
// 去重能吃掉但没必要）。乱序下「推进到大 id 时小 id 还没到」会不会漏？不会：乱序只发生在实时投递，
// 断线重连的回放是按序的；实时段里小 id 的那条要么随后到达（正常处理），要么随连接一起丢（重连从大 id 之后
// 回放就漏了它）—— 这是 SSE 语义本身的缝，网关保证乱序窗口 ≤ 1s，重连退避 ≥ 1s 时这种丢失只发生在
// 「掐断前 1s 内」；补投带新 eventId，最终也会补到。
//
// 自己消息的回流（S3）与 #7 的约定：
// - message 事件的 senderPlatformUserId 命中某个服务账号的 platformUserId → isOwn = true。
// - 通常 message_sent 先到，#7 的 applyGatewayDelivery 已把 msgId 写进出站行 → 这里按 (groupId, msgId)
//   找到它，只补 text / mediaUrl，不新建。
// - message 先于 message_sent 到（乱序 ≤ 1s）→ 这里找不到出站行（它的 msgId 还是 null），插入一行
//   isOwn = true、deliveryStatus = null 的「回流行」。之后 #7 的 applyGatewayDelivery 按 clientMsgId 给出站行写
//   msgId 会撞 unique(groupId, msgId) —— **约定：#7 遇 P2002 时把这一行回流行合并进出站行（删回流行、
//   出站行写 msgId）**。这里无法反向匹配（senderPlatformUserId + text + sentAt 都不唯一），所以合并只能由
//   拿着 clientMsgId 的那一侧做。
// - message_sent / message_failed 本身交给 #7 导出的 applyGatewayDelivery（deps 注入；没注入时按处理失败
//   入册，事件原文在 inbound_events 里等着补处理）。
//
// 建群 job（#11）在收到 member_joined 时自己推进；这里只维护 group_members 与 ws_events
// （ws 事件经 src/services/ws-events.ts 的 emitWsEvent 写，type 的清单在那里；member_changed 是题目 WS 类型表
// 之外的额外类型：{ groupId, platformUserId, accountId | null, change: joined | left }）。
import { z } from "zod";

import { type Clock, systemClock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import { Prisma } from "../db/generated/client.js";
import { enterTerminal } from "./account-service.js";
import { onInboundMessage } from "./agent-run-service.js";
import type { GatewayEvent } from "./gateway-client.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 与 #7（出站 outbox）的接口 -------------------------------------------------------

/**
 * message_sent { clientMsgId, msgId, sentAt } / message_failed { clientMsgId, code } 的记账，由
 * src/services/outbox-service.ts（#7）导出同签名的 applyGatewayDelivery，经 deps 注入这里。
 * sent 时给 msgId + sentAt；failed 时给 code。找不到 clientMsgId 对应的出站行怎么办由 #7 决定。
 */
export type ApplyGatewayDeliveryInput = {
  clientMsgId: string;
  msgId?: string;
  sentAt?: Date;
  code?: string;
};
export type ApplyGatewayDelivery = (
  input: ApplyGatewayDeliveryInput,
  deps: { clock: Clock; log?: IngestLog },
) => Promise<unknown>;

// ---- 类型 ----------------------------------------------------------------------------

export type IngestLog = Pick<Logger, "info" | "warn" | "error">;

export type IngestDeps = {
  clock?: Clock;
  /** worker 传 logger.child({ runId }) */
  log?: IngestLog;
  applyGatewayDelivery?: ApplyGatewayDelivery;
};

export type IngestOutcome = "processed" | "duplicate" | "failed";

export type IngestResult = { eventId: number; outcome: IngestOutcome };

/** inconsistencies.kind 的取值（题目 A2「不能让事件处理中断、不能让内容丢失」） */
export const INCONSISTENCY_KINDS = Object.freeze({
  /** 处理抛错：事务已回滚，原文在 inbound_events */
  eventFailed: "inbound_event_failed",
  /** 事件指向本地没有的群（外部群 / 建群 job 还没落 gatewayGroupId）：事件已入册，不写时间线 */
  unknownGroup: "inbound_unknown_group",
});

// ---- 事件 payload（题目 2.1）-------------------------------------------------------------

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const messageSchema = z.object({
  groupId: z.string().min(1),
  msgId: z.string().min(1),
  senderPlatformUserId: z.string().min(1),
  text: z.string(),
  sentAt: isoDate,
  mediaUrl: z.string().min(1).optional(),
});

const messageSentSchema = z.object({
  clientMsgId: z.string().min(1),
  msgId: z.string().min(1),
  sentAt: isoDate,
});

const messageFailedSchema = z.object({
  clientMsgId: z.string().min(1),
  code: z.string().min(1),
});

const memberSchema = z.object({
  groupId: z.string().min(1),
  platformUserId: z.string().min(1),
});

const accountStatusSchema = z.object({
  accountId: z.string().min(1),
  status: z.enum(["suspended", "session_expired"]),
});

function parsePayload<T extends z.ZodType>(
  schema: T,
  event: GatewayEvent,
): z.output<T> {
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${event.type} 事件 payload 不合法：${issues}`);
  }
  return parsed.data;
}

// ---- 入口 ----------------------------------------------------------------------------

/**
 * 处理一条事件（见文件头）。返回 outcome：processed / duplicate / failed。
 * 只在库不可用（连失败都记不下来）时抛错 —— worker 据此断流重连，事件会从游标之后重拉。
 */
export async function ingest(
  event: GatewayEvent,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const clock = deps.clock ?? systemClock;
  const db = getDb();
  const eventId = String(event.eventId);
  const groupId =
    typeof event.data.groupId === "string" ? event.data.groupId : null;

  // 1. 入册（独立提交）：撞 eventId 唯一 = 重复推送
  try {
    await db.inboundEvent.create({
      data: {
        eventId,
        type: event.type,
        groupId,
        payload: event.data as Prisma.InputJsonObject,
        receivedAt: clock.now(),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await db.inboundEvent.findUniqueOrThrow({
      where: { eventId },
      select: { processedAt: true, attempts: true },
    });
    if (existing.processedAt !== null || existing.attempts > 0) {
      deps.log?.info(
        { eventId: event.eventId, type: event.type },
        "重复事件，跳过",
      );
      return { eventId: event.eventId, outcome: "duplicate" };
    }
    // 上次死在插入与处理之间：补处理
    deps.log?.warn(
      { eventId: event.eventId, type: event.type },
      "事件已入册但未处理，补处理",
    );
  }

  // 2. 处理 + processedAt 同一事务
  try {
    await db.$transaction(async (tx) => {
      await handle(tx, event, { clock, log: deps.log, deps });
      await tx.inboundEvent.update({
        where: { eventId },
        data: { processedAt: clock.now(), lastError: null },
      });
    });
    return { eventId: event.eventId, outcome: "processed" };
  } catch (err) {
    // 3. 失败入册（另起事务）：原文已在 inbound_events；不一致记录 + ws 事件让操作员看见
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.error(
      { err, eventId: event.eventId, type: event.type },
      "入站事件处理失败，已入册",
    );
    await db.$transaction(async (tx) => {
      await tx.inboundEvent.update({
        where: { eventId },
        data: { attempts: { increment: 1 }, lastError: message },
      });
      await recordInconsistency(
        tx,
        INCONSISTENCY_KINDS.eventFailed,
        event,
        `${event.type} 事件（eventId ${eventId}）处理失败：${message}`,
      );
    });
    return { eventId: event.eventId, outcome: "failed" };
  }
}

// ---- 游标 ----------------------------------------------------------------------------

/** event_cursor.lastEventId（单行）；null = 从未消费过（首次连接不带 since：题目里不带 since = 从当前时刻开始）。 */
export async function readCursor(): Promise<number | null> {
  const row = await getDb().eventCursor.findUnique({ where: { id: 1 } });
  if (!row?.lastEventId) return null;
  const n = Number(row.lastEventId);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 推进游标：只在 eventId 更大时写（乱序下后到的小 id 不能把游标拉回去）。一条语句、原子。
 * 手写 SQL 用数据库列名；search_path 由 src/db/client.ts 设好（测试的临时 schema 也走它）。
 */
export async function advanceCursor(
  eventId: number,
  deps: { clock?: Clock } = {},
): Promise<void> {
  const now = (deps.clock ?? systemClock).now();
  const value = String(eventId);
  await getDb().$executeRaw`
    INSERT INTO event_cursor (id, last_event_id, updated_at)
    VALUES (1, ${value}, ${now})
    ON CONFLICT (id) DO UPDATE
      SET last_event_id = EXCLUDED.last_event_id, updated_at = EXCLUDED.updated_at
      WHERE event_cursor.last_event_id IS NULL
         OR event_cursor.last_event_id::bigint < EXCLUDED.last_event_id::bigint`;
}

// ---- 按类型处理 ------------------------------------------------------------------------

type HandleCtx = { clock: Clock; log?: IngestLog; deps: IngestDeps };

async function handle(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  switch (event.type) {
    case "message":
      return handleMessage(tx, event, ctx);
    case "message_sent":
      return handleMessageSent(event, ctx);
    case "message_failed":
      return handleMessageFailed(event, ctx);
    case "member_joined":
      return handleMemberJoined(tx, event, ctx);
    case "member_left":
      return handleMemberLeft(tx, event);
    case "account_status":
      return handleAccountStatus(event, ctx);
    default:
      // 网关新增的类型：原文已入册，不当错误（否则每条都写一行不一致）
      ctx.log?.warn(
        { eventId: event.eventId, type: event.type },
        "未知的事件类型，只入册不处理",
      );
      return;
  }
}

/** 网关 groupId → 本地群；本地没有（外部群 / 建群 job 还没写 gatewayGroupId）→ 写不一致、返回 null。 */
async function resolveGroup(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  gatewayGroupId: string,
): Promise<{ id: string } | null> {
  const group = await tx.group.findUnique({
    where: { gatewayGroupId },
    select: { id: true },
  });
  if (group) return group;
  await recordInconsistency(
    tx,
    INCONSISTENCY_KINDS.unknownGroup,
    event,
    `${event.type} 事件（eventId ${event.eventId}）指向本地没有的群 ${gatewayGroupId}`,
  );
  return null;
}

/** 一行 inconsistencies（原文进 payload）+ 同一事务里的 ws 事件 inconsistency { inconsistencyId, kind, ref, message }。 */
async function recordInconsistency(
  tx: Prisma.TransactionClient,
  kind: string,
  event: GatewayEvent,
  message: string,
): Promise<void> {
  const ref = String(event.eventId);
  const row = await tx.inconsistency.create({
    data: {
      kind,
      ref,
      message,
      payload: {
        eventId: event.eventId,
        type: event.type,
        data: event.data,
      } as Prisma.InputJsonObject,
    },
  });
  await emitWsEvent(tx, "inconsistency", {
    inconsistencyId: row.id,
    kind,
    ref,
    message,
  });
}

async function handleMessage(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(messageSchema, event);
  const group = await resolveGroup(tx, event, data.groupId);
  if (!group) return;

  const account = await tx.account.findUnique({
    where: { platformUserId: data.senderPlatformUserId },
    select: { id: true },
  });
  const isOwn = account !== null;

  let created: boolean;
  if (isOwn) {
    // 回流：出站行已有 msgId（message_sent 先到）→ 只补字段；没有 → 插回流行，等 #7 合并（见文件头约定）
    const existing = await tx.message.findUnique({
      where: { groupId_msgId: { groupId: group.id, msgId: data.msgId } },
      select: { id: true },
    });
    if (existing) {
      await tx.message.update({
        where: { id: existing.id },
        data: {
          isOwn: true,
          text: data.text,
          ...(data.mediaUrl !== undefined ? { mediaUrl: data.mediaUrl } : {}),
        },
      });
      created = false;
    } else {
      const { count } = await tx.message.createMany({
        data: {
          groupId: group.id,
          msgId: data.msgId,
          accountId: account.id,
          senderPlatformUserId: data.senderPlatformUserId,
          isOwn: true,
          text: data.text,
          mediaUrl: data.mediaUrl ?? null,
          sentAt: data.sentAt,
        },
        skipDuplicates: true,
      });
      created = count === 1;
    }
  } else {
    // 外部用户的消息：(groupId, msgId) 撞了就是补投 / 重复，ON CONFLICT DO NOTHING
    const { count } = await tx.message.createMany({
      data: {
        groupId: group.id,
        msgId: data.msgId,
        senderPlatformUserId: data.senderPlatformUserId,
        isOwn: false,
        text: data.text,
        mediaUrl: data.mediaUrl ?? null,
        sentAt: data.sentAt,
      },
      skipDuplicates: true,
    });
    created = count === 1;
    if (created) {
      // agent 触发（#12，A5 第 1 条）：非自己的消息第一次进入时间线 → 同一事务里建 run / 记 pending。
      // 只在 created 时调：补投 / 重复（S2）不会再触发；isOwn 的消息（S3）根本不走这个分支。
      const inserted = await tx.message.findUniqueOrThrow({
        where: { groupId_msgId: { groupId: group.id, msgId: data.msgId } },
        select: { id: true },
      });
      await onInboundMessage(
        { groupId: group.id, messageId: inserted.id },
        { tx, clock: ctx.clock, log: ctx.log },
      );
    }
  }

  // ws 事件只在这条消息**第一次**进入时间线时发：新建行；或回流补进已有的出站行且之前没处理过同 msgId 的
  // message 事件（补投 / 重复的自己消息不再发）。#12 按 isOwn = false 过滤触发 agent。
  let announce = created;
  if (!created && isOwn) {
    const seen = await tx.inboundEvent.count({
      where: {
        type: "message",
        processedAt: { not: null },
        payload: { path: ["msgId"], equals: data.msgId },
      },
    });
    announce = seen === 0;
  }
  if (announce) {
    await emitWsEvent(tx, "message", {
      groupId: group.id,
      msgId: data.msgId,
      isOwn,
    });
  }
  ctx.log?.info(
    {
      eventId: event.eventId,
      groupId: group.id,
      msgId: data.msgId,
      isOwn,
      created,
    },
    created ? "入站消息已写入时间线" : "入站消息已存在，未新建",
  );
}

function requireOutbox(ctx: HandleCtx): ApplyGatewayDelivery {
  const fn = ctx.deps.applyGatewayDelivery;
  if (!fn) {
    throw new Error(
      "message_sent / message_failed 的记账函数未注入（outbox-service.applyGatewayDelivery，#7）",
    );
  }
  return fn;
}

async function handleMessageSent(
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(messageSentSchema, event);
  await requireOutbox(ctx)(
    { clientMsgId: data.clientMsgId, msgId: data.msgId, sentAt: data.sentAt },
    { clock: ctx.clock, log: ctx.log },
  );
}

async function handleMessageFailed(
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(messageFailedSchema, event);
  await requireOutbox(ctx)(
    { clientMsgId: data.clientMsgId, code: data.code },
    { clock: ctx.clock, log: ctx.log },
  );
}

async function handleMemberJoined(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(memberSchema, event);
  const group = await resolveGroup(tx, event, data.groupId);
  if (!group) return;
  // 服务账号按 platformUserId 反查填 accountId；外部用户为 null。role 默认 member；
  // 已在（重复事件 / 建群时已写的群主行）只补 accountId，不动 role / joinedAt。
  const account = await tx.account.findUnique({
    where: { platformUserId: data.platformUserId },
    select: { id: true },
  });
  await tx.groupMember.upsert({
    where: {
      groupId_platformUserId: {
        groupId: group.id,
        platformUserId: data.platformUserId,
      },
    },
    create: {
      groupId: group.id,
      platformUserId: data.platformUserId,
      accountId: account?.id ?? null,
      role: "member",
      joinedAt: ctx.clock.now(),
    },
    update: { ...(account ? { accountId: account.id } : {}) },
  });
  await emitWsEvent(tx, "member_changed", {
    groupId: group.id,
    platformUserId: data.platformUserId,
    accountId: account?.id ?? null,
    change: "joined",
  });
}

async function handleMemberLeft(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
): Promise<void> {
  const data = parsePayload(memberSchema, event);
  const group = await resolveGroup(tx, event, data.groupId);
  if (!group) return;
  // 终态级联已删过的行这里 count = 0，照常发事件（前端按它刷新成员即可，幂等）
  await tx.groupMember.deleteMany({
    where: { groupId: group.id, platformUserId: data.platformUserId },
  });
  const account = await tx.account.findUnique({
    where: { platformUserId: data.platformUserId },
    select: { id: true },
  });
  await emitWsEvent(tx, "member_changed", {
    groupId: group.id,
    platformUserId: data.platformUserId,
    accountId: account?.id ?? null,
    change: "left",
  });
}

async function handleAccountStatus(
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(accountStatusSchema, event);
  // 终态级联走 account-service 的统一入口（自己的事务）：已在该终态时静默；账号不存在 → NotFound → 失败入册
  await enterTerminal(data.accountId, data.status, "gateway_event", {
    clock: ctx.clock,
    log: ctx.log,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
