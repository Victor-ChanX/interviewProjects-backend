// 入站事件（题目 2.1 事件流 + A2 入站条款，issue #8）：一条 SSE 帧怎么变成库里的状态。
//
// 三层去重 / 容错，各管一件事：
// 1. **事件级**：inbound_events.eventId 唯一。先入册（独立提交），再在一个事务里「锁住这一行 → 确认还没处理 →
//    处理 → 写 processedAt」。同一事件推两次（S2）、多个副本同时收到同一事件：锁上排队，后到的看见 processedAt
//    已写就是 duplicate，不会处理第二遍。
// 2. **消息级**：messages 的 (groupId, msgId) 唯一。补投 / 乱序带来的同一条消息用新 eventId 再来时，
//    createMany({ skipDuplicates }) 是 ON CONFLICT DO NOTHING —— 不抛错、不写第二行、不再发 ws 事件
//    （agent 触发只在新建行时发生，所以也不会被重复触发）。
// 3. **处理失败不中断、不丢、会重试**：处理抛错 → 事务回滚，原文还在 inbound_events；另起事务写 attempts + 1 /
//    lastError / nextAttemptAt（有界指数退避），首次失败时写一行 inconsistencies { kind: inbound_event_failed,
//    ref: eventId } + ws inconsistency 让操作员看见，调用方（worker）继续下一条。之后由 inbound-retry-worker 按
//    nextAttemptAt 领取重试（retryDueEvents），网关重推同一事件也算一次重试；重试成功时把这条事件的失败记录标为
//    已处理（resolvedBy = system）。失败 MAX_ATTEMPTS 次后停止自动重试（nextAttemptAt 置空），留给操作员。
//    入册时 nextAttemptAt 就排上「收到时刻 + 孤儿宽限」：进程死在入册与处理之间，这一行也会被重试 worker 接手。
//    ingest 本身只在「连记失败都记不下来」（库不可用）时才抛。
//
// 处理必须与自己的后果同生共死：message_sent / message_failed 的记账（outbox-service.applyGatewayDelivery）、
// account_status 的终态级联（account-service.enterTerminalInTx）都在这个事务里做 —— 进程死在中间，事件整个重来，
// 不会出现「一半生效、processedAt 已写」或「记账已生效、后果没跟上、重放又被当成重复跳过」。
// 业务日志在 commit 之后记（afterCommit）。
//
// 成员事件按「最后一次为准」：同一 (群, platformUserId) 已有 eventId 更大的 member_joined / member_left 处理过时，
// 这一条就是过时的（1 秒乱序窗口里后到的旧事件、或失败后晚些才重试成功的旧事件），跳过 —— 否则一条迟到的
// member_joined 会把已经退群的人加回成员表。
//
// 游标（event_cursor.lastEventId）由 src/workers/inbound-worker.ts 维护，规则见那里。
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
import { enterTerminalInTx, logTransition } from "./account-service.js";
import { onInboundMessage } from "./agent-run-service.js";
import type { GatewayEvent } from "./gateway-client.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 与 #7（出站 outbox）的接口 -------------------------------------------------------

/**
 * message_sent { clientMsgId, msgId, sentAt } / message_failed { clientMsgId, code } 的记账，由
 * src/services/outbox-service.ts（#7）导出同签名的 applyGatewayDelivery，经 deps 注入这里。
 * 在处理这条事件的事务（tx）里跑；业务日志交给 afterCommit。
 * sent 时给 msgId + sentAt；failed 时给 code。找不到 clientMsgId 对应的出站行怎么办由 #7 决定。
 */
export type ApplyGatewayDeliveryInput = {
  clientMsgId: string;
  msgId?: string;
  sentAt?: Date;
  code?: string;
};
export type ApplyGatewayDelivery = (
  tx: Prisma.TransactionClient,
  input: ApplyGatewayDeliveryInput,
  deps: { clock: Clock; log?: IngestLog; afterCommit: AfterCommit },
) => Promise<unknown>;

/** 登记一段要在事务 commit 之后执行的代码（业务日志） */
export type AfterCommit = (fn: () => void) => void;

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

export type RetryResult = {
  /** 本次领到的到期事件数 */
  claimed: number;
  processed: number;
  failed: number;
};

/** 入册后这么久还没处理完 = 处理它的进程死了：重试 worker 接手（正常处理是毫秒级） */
export const ORPHAN_GRACE_MS = 30_000;
/** 失败重试的退避：base × 2^(attempts-1)，封顶 cap */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 60_000;
/** 失败这么多次后停止自动重试，留给操作员（inconsistencies 里有记录） */
export const MAX_ATTEMPTS = 8;
/** 重试 worker 领取时把 nextAttemptAt 往后推这么久：处理中的事件不会被别的副本同时领走；进程死了到点再被领 */
export const RETRY_LEASE_MS = 30_000;
/** 一次最多领多少条到期事件 */
export const RETRY_BATCH = 50;
/** 重试成功后自动把失败记录标为已处理时的 resolvedBy */
export const AUTO_RESOLVED_BY = "system";

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
 * 处理一条从事件流收到的事件（见文件头）。返回 outcome：processed / duplicate / failed。
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
  const now = clock.now();

  // 1. 入册（独立提交）：撞 eventId 唯一 = 重复推送
  try {
    await db.inboundEvent.create({
      data: {
        eventId,
        type: event.type,
        groupId,
        payload: event.data as Prisma.InputJsonObject,
        receivedAt: now,
        nextAttemptAt: new Date(now.getTime() + ORPHAN_GRACE_MS),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await db.inboundEvent.findUniqueOrThrow({
      where: { eventId },
      select: { processedAt: true },
    });
    if (existing.processedAt !== null) {
      deps.log?.info(
        { eventId: event.eventId, type: event.type },
        "重复事件，跳过",
      );
      return { eventId: event.eventId, outcome: "duplicate" };
    }
    // 入册过但没处理成（上次失败、或进程死在入册与处理之间）：网关重推就是一次重试
    deps.log?.warn(
      { eventId: event.eventId, type: event.type },
      "事件已入册但未处理，补处理",
    );
  }

  // 2. 锁行 + 处理 + processedAt 同一事务
  return processEvent(event, deps);
}

/**
 * 到期的未处理事件（失败待重试 / 孤儿）重新处理一遍：inbound-retry-worker 每 tick 调。
 * 领取 = 一条语句把到期行的 nextAttemptAt 推到租约之后（FOR UPDATE SKIP LOCKED，多副本各领各的，正在处理的行
 * 被锁着也会跳过）；按 eventId 升序逐条处理，失败照常记账、重排退避。
 */
export async function retryDueEvents(
  deps: IngestDeps & { limit?: number } = {},
): Promise<RetryResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const leaseUntil = new Date(now.getTime() + RETRY_LEASE_MS);
  const limit = deps.limit ?? RETRY_BATCH;
  const rows = await getDb().$queryRaw<
    { event_id: string; type: string; payload: Prisma.JsonValue }[]
  >`
    UPDATE inbound_events SET next_attempt_at = ${leaseUntil}
    WHERE id IN (
      SELECT id FROM inbound_events
      WHERE processed_at IS NULL AND next_attempt_at <= ${now}
      ORDER BY event_id::bigint
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING event_id, type, payload`;
  rows.sort((a, b) => Number(a.event_id) - Number(b.event_id));

  const result: RetryResult = { claimed: rows.length, processed: 0, failed: 0 };
  for (const row of rows) {
    const payload = row.payload;
    const data =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const outcome = await processEvent(
      { eventId: Number(row.event_id), type: row.type, data },
      deps,
    );
    if (outcome.outcome === "processed") result.processed += 1;
    if (outcome.outcome === "failed") result.failed += 1;
  }
  return result;
}

/** 已入册的一条事件：锁行 → 还没处理才处理 → processedAt，一个事务；失败另起事务记账。 */
async function processEvent(
  event: GatewayEvent,
  deps: IngestDeps,
): Promise<IngestResult> {
  const clock = deps.clock ?? systemClock;
  const db = getDb();
  const eventId = String(event.eventId);
  const committed: (() => void)[] = [];
  try {
    const outcome = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ processed_at: Date | null }[]>`
        SELECT processed_at FROM inbound_events WHERE event_id = ${eventId} FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new Error(`inbound_events 里没有 eventId ${eventId}`);
      if (current.processed_at !== null) return "duplicate" as const;
      const now = clock.now();
      await handle(tx, event, {
        clock,
        log: deps.log,
        deps,
        afterCommit: (fn) => committed.push(fn),
      });
      const row = await tx.inboundEvent.update({
        where: { eventId },
        data: { processedAt: now, lastError: null, nextAttemptAt: null },
        select: { attempts: true },
      });
      if (row.attempts > 0) await resolveFailureRecords(tx, eventId, now);
      return "processed" as const;
    });
    for (const fn of committed) fn();
    if (outcome === "duplicate") {
      deps.log?.info(
        { eventId: event.eventId, type: event.type },
        "重复事件，跳过",
      );
    }
    return { eventId: event.eventId, outcome };
  } catch (err) {
    await recordFailure(event, err, deps);
    return { eventId: event.eventId, outcome: "failed" };
  }
}

/**
 * 处理失败（事务已回滚，原文在 inbound_events）：attempts + 1、lastError、按退避排下一次；
 * 首次失败写不一致记录 + ws 事件让操作员看见，达到上限时再写一条并停止自动重试。
 */
async function recordFailure(
  event: GatewayEvent,
  err: unknown,
  deps: IngestDeps,
): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const eventId = String(event.eventId);
  const message = err instanceof Error ? err.message : String(err);
  const now = clock.now();
  const attempts = await getDb().$transaction(async (tx) => {
    const { attempts } = await tx.inboundEvent.update({
      where: { eventId },
      data: { attempts: { increment: 1 }, lastError: message },
      select: { attempts: true },
    });
    const giveUp = attempts >= MAX_ATTEMPTS;
    await tx.inboundEvent.update({
      where: { eventId },
      data: {
        nextAttemptAt: giveUp
          ? null
          : new Date(now.getTime() + retryDelay(attempts)),
      },
    });
    if (attempts === 1) {
      await recordInconsistency(
        tx,
        INCONSISTENCY_KINDS.eventFailed,
        event,
        `${event.type} 事件（eventId ${eventId}）处理失败，将自动重试：${message}`,
      );
    } else if (giveUp) {
      await recordInconsistency(
        tx,
        INCONSISTENCY_KINDS.eventFailed,
        event,
        `${event.type} 事件（eventId ${eventId}）连续 ${attempts} 次处理失败，已停止自动重试：${message}`,
      );
    }
    return attempts;
  });
  deps.log?.error(
    { err, eventId: event.eventId, type: event.type, attempts },
    "入站事件处理失败，已入册待重试",
  );
}

function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);
}

/** 重试成功：这条事件之前的失败记录标为已处理（与操作员手动标记同一套字段与 ws 事件）。 */
async function resolveFailureRecords(
  tx: Prisma.TransactionClient,
  eventId: string,
  now: Date,
): Promise<void> {
  const open = await tx.inconsistency.findMany({
    where: {
      kind: INCONSISTENCY_KINDS.eventFailed,
      ref: eventId,
      resolvedAt: null,
    },
    select: { id: true },
  });
  if (open.length === 0) return;
  await tx.inconsistency.updateMany({
    where: { id: { in: open.map((r) => r.id) } },
    data: { resolvedAt: now, resolvedBy: AUTO_RESOLVED_BY },
  });
  for (const { id } of open) {
    await emitWsEvent(tx, "inconsistency_resolved", {
      id,
      resolvedAt: now.toISOString(),
      resolvedBy: AUTO_RESOLVED_BY,
    });
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

type HandleCtx = {
  clock: Clock;
  log?: IngestLog;
  deps: IngestDeps;
  afterCommit: AfterCommit;
};

async function handle(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  switch (event.type) {
    case "message":
      return handleMessage(tx, event, ctx);
    case "message_sent":
      return handleMessageSent(tx, event, ctx);
    case "message_failed":
      return handleMessageFailed(tx, event, ctx);
    case "member_joined":
      return handleMemberJoined(tx, event, ctx);
    case "member_left":
      return handleMemberLeft(tx, event, ctx);
    case "account_status":
      return handleAccountStatus(tx, event, ctx);
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
  // C1：带 mediaUrl 的消息排上下载（media-worker 按 mediaNextAttemptAt 领取，不在这个事务里下载）
  const mediaSchedule =
    data.mediaUrl !== undefined
      ? { mediaUrl: data.mediaUrl, mediaNextAttemptAt: ctx.clock.now() }
      : {};

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
        data: { isOwn: true, text: data.text, ...mediaSchedule },
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
          ...mediaSchedule,
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
        ...mediaSchedule,
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
  ctx.afterCommit(() =>
    ctx.log?.info(
      {
        eventId: event.eventId,
        groupId: group.id,
        msgId: data.msgId,
        isOwn,
        created,
      },
      created ? "入站消息已写入时间线" : "入站消息已存在，未新建",
    ),
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
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(messageSentSchema, event);
  await requireOutbox(ctx)(
    tx,
    { clientMsgId: data.clientMsgId, msgId: data.msgId, sentAt: data.sentAt },
    { clock: ctx.clock, log: ctx.log, afterCommit: ctx.afterCommit },
  );
}

async function handleMessageFailed(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(messageFailedSchema, event);
  await requireOutbox(ctx)(
    tx,
    { clientMsgId: data.clientMsgId, code: data.code },
    { clock: ctx.clock, log: ctx.log, afterCommit: ctx.afterCommit },
  );
}

/**
 * 同一 (群, platformUserId) 已有 eventId 更大的成员事件处理过：这一条过时了（见文件头「成员事件按最后一次为准」）。
 * 按网关 groupId 比（inbound_events.group_id 存的就是它），payload 里取 platformUserId。
 */
async function isStaleMembershipEvent(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  gatewayGroupId: string,
  platformUserId: string,
): Promise<boolean> {
  const newer = await tx.$queryRaw<{ event_id: string }[]>`
    SELECT event_id FROM inbound_events
    WHERE type IN ('member_joined', 'member_left')
      AND group_id = ${gatewayGroupId}
      AND processed_at IS NOT NULL
      AND payload->>'platformUserId' = ${platformUserId}
      AND event_id::bigint > ${event.eventId}
    LIMIT 1`;
  if (newer.length === 0) return false;
  return true;
}

async function handleMemberJoined(
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(memberSchema, event);
  const group = await resolveGroup(tx, event, data.groupId);
  if (!group) return;
  if (
    await isStaleMembershipEvent(tx, event, data.groupId, data.platformUserId)
  ) {
    ctx.afterCommit(() =>
      ctx.log?.info(
        { eventId: event.eventId, platformUserId: data.platformUserId },
        "过时的 member_joined（已有更新的成员事件），跳过",
      ),
    );
    return;
  }
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
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(memberSchema, event);
  const group = await resolveGroup(tx, event, data.groupId);
  if (!group) return;
  if (
    await isStaleMembershipEvent(tx, event, data.groupId, data.platformUserId)
  ) {
    ctx.afterCommit(() =>
      ctx.log?.info(
        { eventId: event.eventId, platformUserId: data.platformUserId },
        "过时的 member_left（已有更新的成员事件），跳过",
      ),
    );
    return;
  }
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
  tx: Prisma.TransactionClient,
  event: GatewayEvent,
  ctx: HandleCtx,
): Promise<void> {
  const data = parsePayload(accountStatusSchema, event);
  // 终态级联走 account-service 的统一入口，在这条事件的事务里：已在该终态时静默；账号不存在 → NotFound → 失败入册
  const result = await enterTerminalInTx(
    tx,
    data.accountId,
    data.status,
    "gateway_event",
    ctx.clock.now(),
  );
  ctx.afterCommit(() =>
    logTransition(
      data.accountId,
      data.status,
      "gateway_event",
      result,
      ctx.log,
    ),
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}
