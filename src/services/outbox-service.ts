// 出站 outbox（题目 2.1「发消息」+ 2.3 `POST /api/groups/:id/send` + A2，issue #7）。
//
// 一切从一个事实出发：进程随时会死。所以顺序永远是 **写库（意图）→ commit → 调网关 → 写库（结果）**：
// - 入队（enqueueMessage）：与业务校验同一事务落一行 messages（deliveryStatus = queued）+ ws_events；
//   请求返回 202 只保证「记录已落库」。
// - 领取（claimBatch）：`FOR UPDATE SKIP LOCKED` 一条语句领一批，标 claimedBy / lockedAt、attempts + 1、
//   写一行 outbound_attempts（finishedAt 为空 = 结果未记），commit 后才调网关。多副本各领各的；
//   **同一账号同一时刻只在途一条**（顺序发出；限流中的账号一条都不领）。
// - 记账（record*）：都是条件更新 `where { id, deliveryStatus, claimedBy }`——级联（账号进终态 / 群不可写）
//   可能已在途中把行置 cancelled，这时 count = 0：不覆盖，只释放领取标记。状态变化都在同一事务里写 ws_events。
// - 结果不明（504 / 客户端超时 / 连接被重置 / 领取者死在发出与记账之间）→ unknown，**确认对方没收到之前不重发**：
//   resolveUnknown 每 tick 按 by-client-id 查，200 → sent；404 且超过 2 秒 → 确认没发出：用同一个 clientMsgId
//   重发一次（resendCount 0 → 1），已经重发过 → failed NETWORK_TIMEOUT；查询不可用（503 / 连不上）→ 保持 unknown。
//   tick ≤ 500ms 时「收到 504 起 5 秒内定态」：2s 确认 + 同一 tick 里重发。
// - 网关同步错误表（A2）在 dispatchOne：429 → 账号 rate_limited + 该行回 queued（nextAttemptAt = 到期）；
//   ACCOUNT_SUSPENDED / SESSION_EXPIRED → 该行 cancelled + 账号进终态（级联把它其余 queued 的行 cancelled）；
//   GROUP_WRITE_FORBIDDEN → 该行 failed + 群 unreachable（src/services/group-service.ts）；
//   SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE（及其他 4xx）→ failed（同名 failCode）；503 / 5xx / 连不上 → 回 queued，
//   有界退避（nextAttemptAt），attempts 达上限 → failed GATEWAY_UNAVAILABLE。
// - message_sent / message_failed 事件的记账入口 applyGatewayDelivery 给入站 worker（#8）调。
// - 序列（#15）：消息进终局（sent / failed / cancelled）时 settle 在同一事务里调 sequence-service.onOutboundSettled，
//   把对应的序列步骤改 sent / failed 并排下一步 —— 「发出」= 这条消息变 sent 的时刻。
//
// 手写 SQL 用的是数据库列名（@map 的值）；`${}` 是绑定参数。
import { randomInt, randomUUID } from "node:crypto";

import { type Clock, systemClock } from "../core/clock.js";
import { Conflict, DomainError, NotFound } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type {
  DeliveryStatus,
  Message,
  Prisma,
} from "../db/generated/client.js";
import {
  DEFAULT_RATE_LIMIT_SECONDS,
  enterRateLimited,
  enterTerminal,
  isTerminal,
  terminalFromGatewayError,
} from "./account-service.js";
import {
  type GatewayClient,
  GatewayResponseError,
  GatewayUnreachableError,
} from "./gateway-client.js";
import { markGroupUnreachable } from "./group-service.js";
import { onOutboundSettled } from "./sequence-service.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 常量（有界重试 / 确认窗口 / 回收阈值）------------------------------------------------

/** 503 / 网络错的退避：base × 2^(attempts-1)，封顶 cap，再加 0–jitter 的随机抖动 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const BACKOFF_JITTER_MS = 250;
/** 连续 503 / 网络错这么多次后转 failed（failCode = GATEWAY_UNAVAILABLE），不让一条消息永远占着队列 */
export const MAX_ATTEMPTS = 8;
/** 504 之后 by-client-id 仍 404 超过这么久，即可确定没发出（题目 2.1：超过 2 秒） */
export const UNKNOWN_CONFIRM_MS = 2_000;
/** 领取后这么久仍未记账 = 领取者死了（网关单次超时 10s，留足余量）：转 unknown 走确认流程，不直接重发 */
export const STALE_CLAIM_MS = 30_000;
/** 一次 tick 最多领 / 最多确认的条数 */
export const DEFAULT_BATCH_SIZE = 20;

export const NETWORK_TIMEOUT_CODE = "NETWORK_TIMEOUT";
/** outbound_attempts.errorCode：领取者死了、这次投递没有响应 */
export const CLAIM_LOST_CODE = "CLAIM_LOST";
export const GATEWAY_UNAVAILABLE_FAIL_CODE = "GATEWAY_UNAVAILABLE";

// ---- 类型 ------------------------------------------------------------------------------

export type OutboxDeps = {
  clock?: Clock;
  /** 路由传 request.log；worker 传 logger.child({ workerId }) */
  log?: Pick<Logger, "info" | "warn" | "error">;
};

/** 谁入的队：只进日志。序列（#15）/ agent（#12）到时用各自的值 */
export type EnqueueSource = "operator" | "sequence" | "agent";

export type EnqueueInput = {
  groupId: string;
  accountId: string;
  text: string;
  source: EnqueueSource;
};

export type EnqueueResult = { messageId: string; clientMsgId: string };

/** 领到的一条：发送要用的全部字段 */
export type ClaimedMessage = {
  id: string;
  clientMsgId: string;
  groupId: string;
  gatewayGroupId: string | null;
  accountId: string;
  text: string;
  /** 本次是第几次投递（含首发，领取时已 +1） */
  attempts: number;
  resendCount: number;
};

export type DispatchDeps = OutboxDeps & {
  gateway: GatewayClient;
  workerId: string;
};

/** dispatchOne 的结果：这条消息在本次投递后进了哪个状态（requeued = 回 queued 稍后再试） */
export type DispatchOutcome =
  "accepted" | "failed" | "cancelled" | "unknown" | "requeued";

export type GatewayDeliveryInput = {
  clientMsgId: string;
  /** message_sent（#8 的入站 service 传 Date，by-client-id 查询是 ISO 字符串，都收） */
  msgId?: string;
  sentAt?: string | Date;
  /** message_failed：GROUP_WRITE_FORBIDDEN | ACCOUNT_SUSPENDED */
  code?: string;
};

export type ApplyDeliveryResult = {
  /** false = 找不到这条 / 已经是终态（重复事件），什么都没改 */
  applied: boolean;
  status: DeliveryStatus | null;
};

export type ResolveUnknownStats = {
  checked: number;
  sent: number;
  requeued: number;
  failed: number;
  /** 仍 unknown：未满 2 秒或查询不可用 */
  pending: number;
};

type Tx = Prisma.TransactionClient;
type MessageEventRow = Pick<
  Message,
  "groupId" | "msgId" | "clientMsgId" | "deliveryStatus" | "failCode"
>;

// ---- 入队 ------------------------------------------------------------------------------

/**
 * 与校验同一事务：群存在且 active 且已在网关建好 → 账号是群成员（409 ACCOUNT_NOT_IN_GROUP）→
 * 账号 online / rate_limited（其余 409 ACCOUNT_UNAVAILABLE；rate_limited 照常受理保持 queued，到期后按序发出）。
 * 行：isOwn = true、deliveryStatus = queued、sentAt = 受理时刻（发出后改为网关的 sentAt）、
 * senderPlatformUserId = 账号的 platformUserId；同事务写 ws_events message（自己的消息从 queued 起就在时间线里）。
 */
export async function enqueueMessage(
  input: EnqueueInput,
  deps: OutboxDeps = {},
): Promise<EnqueueResult> {
  const result = await getDb().$transaction((tx) =>
    enqueueMessageInTx(tx, input, deps),
  );

  deps.log?.info(
    {
      groupId: input.groupId,
      accountId: input.accountId,
      clientMsgId: result.clientMsgId,
      source: input.source,
    },
    "出站消息已入队",
  );
  return result;
}

/**
 * enqueueMessage 的事务体，给「入队必须与别的写同一事务」的调用方用：agent 的 send_message（#12）要把
 * agent_idempotency (runId, key → clientMsgId) 与出站行一起提交 —— 分两个事务，进程死在中间就是
 * 「已入队却没有幂等记录 → 恢复后再入队一次」，正是 A5 第 8 条禁止的重复发送。
 * 校验与写入同 enqueueMessage；不打日志（commit 由调用方掌握，日志在 commit 之后记）。
 */
export async function enqueueMessageInTx(
  tx: Tx,
  input: EnqueueInput,
  deps: OutboxDeps = {},
): Promise<EnqueueResult> {
  const clock = deps.clock ?? systemClock;
  const group = await tx.group.findUnique({ where: { id: input.groupId } });
  if (!group) {
    throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除", {
      groupId: input.groupId,
    });
  }
  if (group.status !== "active" || group.gatewayGroupId === null) {
    throw new Conflict(
      "GROUP_UNREACHABLE",
      group.status === "active"
        ? "群尚未在网关建好，稍后再试"
        : `群已${group.status === "left" ? "退出" : "不可写"}，不能再发消息`,
      { groupId: input.groupId, status: group.status },
    );
  }
  const member = await tx.groupMember.findFirst({
    where: { groupId: input.groupId, accountId: input.accountId },
    select: { accountId: true },
  });
  if (!member) {
    throw new Conflict(
      "ACCOUNT_NOT_IN_GROUP",
      "该账号不是这个群的成员，等它入群后再发",
      { groupId: input.groupId, accountId: input.accountId },
    );
  }
  const account = await tx.account.findUnique({
    where: { id: input.accountId },
  });
  if (!account) {
    throw new NotFound("ACCOUNT_NOT_FOUND", `账号 ${input.accountId} 不存在`, {
      accountId: input.accountId,
    });
  }
  if (
    (account.status !== "online" && account.status !== "rate_limited") ||
    account.platformUserId === null
  ) {
    throw new Conflict(
      "ACCOUNT_UNAVAILABLE",
      isTerminal(account.status)
        ? `账号已${account.status === "suspended" ? "被平台停用" : "会话失效"}，不能发消息`
        : `账号当前是 ${account.status}，先 connect 再发`,
      { accountId: input.accountId, status: account.status },
    );
  }

  const now = clock.now();
  const clientMsgId = randomUUID();
  const row = await tx.message.create({
    data: {
      groupId: input.groupId,
      accountId: account.id,
      clientMsgId,
      senderPlatformUserId: account.platformUserId,
      isOwn: true,
      text: input.text,
      sentAt: now,
      deliveryStatus: "queued",
    },
  });
  await emitMessageEvent(tx, row);
  return { messageId: row.id, clientMsgId };
}

// ---- 领取 ------------------------------------------------------------------------------

/**
 * 一条语句领一批（交互式事务里 $queryRaw 标签模板，Prisma 查询 API 没有 FOR UPDATE）：
 * - queued、未被领、到点（next_attempt_at 空或 ≤ now）；
 * - 账号不在限流期（status = rate_limited 且 rate_limited_until > now 的一条都不领）；
 * - 该账号没有在途的一条（claimed_by 非空）—— 顺序发出；
 * - `FOR UPDATE OF m, a SKIP LOCKED`：别的副本正在领同一账号（锁着 accounts 行）时跳过该账号的行，
 *   两个副本不会同时各拿一条同账号的消息；commit 后靠 claimed_by 继续互斥。
 * 一批里同一账号只取最早一条（其余留在 queued，下个 tick 再看），然后标 claimedBy / lockedAt、attempts + 1、
 * 写 outbound_attempts。行锁不跨越 HTTP：commit 后才调网关。
 */
export async function claimBatch(
  workerId: string,
  now: Date,
  limit: number = DEFAULT_BATCH_SIZE,
): Promise<ClaimedMessage[]> {
  return getDb().$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<
      {
        id: string;
        account_id: string;
        attempts: number;
        resend_count: number;
      }[]
    >`
      SELECT m.id, m.account_id, m.attempts, m.resend_count
      FROM messages m
      JOIN accounts a ON a.id = m.account_id
      WHERE m.delivery_status = 'queued'
        AND m.claimed_by IS NULL
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ${now})
        AND NOT (a.status = 'rate_limited' AND a.rate_limited_until > ${now})
        AND NOT EXISTS (
          SELECT 1 FROM messages f
          WHERE f.account_id = m.account_id
            AND f.delivery_status = 'queued'
            AND f.claimed_by IS NOT NULL
        )
      ORDER BY m.sent_at, m.id
      LIMIT ${limit}
      FOR UPDATE OF m, a SKIP LOCKED
    `;
    const seenAccounts = new Set<string>();
    const picked = candidates.filter((c) => {
      if (seenAccounts.has(c.account_id)) return false;
      seenAccounts.add(c.account_id);
      return true;
    });
    if (picked.length === 0) return [];

    const ids = picked.map((c) => c.id);
    await tx.message.updateMany({
      where: { id: { in: ids } },
      data: { claimedBy: workerId, lockedAt: now, attempts: { increment: 1 } },
    });
    await tx.outboundAttempt.createMany({
      data: picked.map((c) => ({
        messageId: c.id,
        attemptNo: c.attempts + 1,
        isResend: c.resend_count > 0,
        startedAt: now,
      })),
    });
    const rows = await tx.message.findMany({
      where: { id: { in: ids } },
      include: { group: { select: { gatewayGroupId: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // 保持领取语句的顺序（sent_at, id）
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r || r.clientMsgId === null || r.accountId === null) {
        throw new Error(`领到的出站行 ${id} 缺少 clientMsgId / accountId`);
      }
      return {
        id: r.id,
        clientMsgId: r.clientMsgId,
        groupId: r.groupId,
        gatewayGroupId: r.group.gatewayGroupId,
        accountId: r.accountId,
        text: r.text,
        attempts: r.attempts,
        resendCount: r.resendCount,
      };
    });
  });
}

// ---- 记账（条件更新 + 释放领取标记 + 事件）----------------------------------------------------

type SettleData = Omit<
  Prisma.MessageUpdateManyMutationInput,
  "claimedBy" | "lockedAt"
>;

/**
 * 在事务里把行从 from 状态之一改成 data 描述的状态，并释放领取标记。
 * count = 0（级联已把它改成 cancelled、或不是本 worker 领的）：不覆盖别人的结果，只把本 worker 的领取标记清掉。
 * 返回改后的行（applied = true）或 null。
 */
async function settle(
  tx: Tx,
  messageId: string,
  workerId: string | null,
  from: DeliveryStatus[],
  data: SettleData,
  now: Date,
): Promise<Message | null> {
  const changed = await tx.message.updateMany({
    where: {
      id: messageId,
      deliveryStatus: { in: from },
      ...(workerId === null ? {} : { claimedBy: workerId }),
    },
    data: { ...data, claimedBy: null, lockedAt: null },
  });
  if (changed.count === 0) {
    if (workerId !== null) {
      await tx.message.updateMany({
        where: { id: messageId, claimedBy: workerId },
        data: { claimedBy: null, lockedAt: null },
      });
    }
    return null;
  }
  const row = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
  await emitMessageEvent(tx, row);
  // #15：序列步骤跟着这条消息的终局走（同一事务）：sent → 步骤 sent 并以网关 sentAt 为基准排下一步；
  // failed / cancelled → 步骤 failed 并以此刻为基准继续。不是序列消息 / 步骤已结时是空操作。
  await onOutboundSettled(tx, row, now);
  return row;
}

/** 把这条消息最近一次未记结果的 outbound_attempts 行补上结果（领取时写的那行）。 */
async function finishAttempt(
  tx: Tx,
  messageId: string,
  now: Date,
  result: {
    httpStatus: number | null;
    errorCode: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await tx.outboundAttempt.updateMany({
    where: { messageId, finishedAt: null },
    data: {
      finishedAt: now,
      httpStatus: result.httpStatus,
      errorCode: result.errorCode,
      detail:
        result.detail === undefined
          ? undefined
          : (JSON.parse(
              JSON.stringify(result.detail),
            ) as Prisma.InputJsonValue),
    },
  });
}

/** ws_events message：{ groupId, msgId, clientMsgId, isOwn, deliveryStatus, failCode } —— 自己的消息每次状态变化推一次 */
async function emitMessageEvent(tx: Tx, row: MessageEventRow): Promise<void> {
  await emitWsEvent(tx, "message", {
    groupId: row.groupId,
    msgId: row.msgId,
    clientMsgId: row.clientMsgId,
    isOwn: true,
    deliveryStatus: row.deliveryStatus,
    failCode: row.failCode,
  });
}

/** 网关 202：queued → accepted（acceptedAt）。 */
export async function recordAccepted(
  messageId: string,
  workerId: string,
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  const row = await getDb().$transaction(async (tx) => {
    await finishAttempt(tx, messageId, now, {
      httpStatus: 202,
      errorCode: null,
    });
    return settle(
      tx,
      messageId,
      workerId,
      ["queued"],
      { deliveryStatus: "accepted", acceptedAt: now, lastError: null },
      now,
    );
  });
  return row !== null;
}

/** 明确失败（4xx 业务拒绝 / 重发后仍未发出 / 重试耗尽）：→ failed + failCode，不再重试。 */
export async function recordFailed(
  messageId: string,
  workerId: string | null,
  code: string,
  opts: { httpStatus?: number | null; from?: DeliveryStatus[] } = {},
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  const row = await getDb().$transaction(async (tx) => {
    await finishAttempt(tx, messageId, now, {
      httpStatus: opts.httpStatus ?? null,
      errorCode: code,
    });
    return settle(
      tx,
      messageId,
      workerId,
      opts.from ?? ["queued", "accepted", "unknown"],
      { deliveryStatus: "failed", failCode: code, lastError: code },
      now,
    );
  });
  return row !== null;
}

/** 账号被网关判终态：该行 cancelled + failCode = 网关码（其余 queued 行由账号级联置 cancelled / ACCOUNT_TERMINAL）。 */
export async function recordCancelled(
  messageId: string,
  workerId: string,
  code: string,
  httpStatus: number,
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  const row = await getDb().$transaction(async (tx) => {
    await finishAttempt(tx, messageId, now, { httpStatus, errorCode: code });
    return settle(
      tx,
      messageId,
      workerId,
      ["queued"],
      { deliveryStatus: "cancelled", failCode: code, lastError: code },
      now,
    );
  });
  return row !== null;
}

/** 结果不明（504 / 客户端超时 / 连接重置）：→ unknown + unknownSince，由 resolveUnknown 按 by-client-id 落定。 */
export async function recordUnknown(
  messageId: string,
  workerId: string,
  reason: { httpStatus: number | null; errorCode: string; detail?: unknown },
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  const row = await getDb().$transaction(async (tx) => {
    await finishAttempt(tx, messageId, now, reason);
    return settle(
      tx,
      messageId,
      workerId,
      ["queued"],
      {
        deliveryStatus: "unknown",
        unknownSince: now,
        lastError: reason.errorCode,
      },
      now,
    );
  });
  return row !== null;
}

/** 回 queued 稍后再试（429 到期后 / 503 与网络错的退避）：只改排期，不改状态，不发事件。 */
export async function requeue(
  messageId: string,
  workerId: string,
  schedule: {
    nextAttemptAt: Date;
    httpStatus: number | null;
    errorCode: string;
    detail?: unknown;
  },
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  return getDb().$transaction(async (tx) => {
    await finishAttempt(tx, messageId, now, schedule);
    const changed = await tx.message.updateMany({
      where: { id: messageId, deliveryStatus: "queued", claimedBy: workerId },
      data: {
        nextAttemptAt: schedule.nextAttemptAt,
        lastError: schedule.errorCode,
        claimedBy: null,
        lockedAt: null,
      },
    });
    if (changed.count === 0) {
      await tx.message.updateMany({
        where: { id: messageId, claimedBy: workerId },
        data: { claimedBy: null, lockedAt: null },
      });
    }
    return changed.count > 0;
  });
}

/**
 * 网关确认已发出（message_sent 事件 / by-client-id 200）：→ sent，msgId、sentAt 改为网关的值。
 * 网关的话是真相：queued / accepted / unknown / cancelled 都能进 sent（cancelled 的行在途中被级联取消、
 * 网关却已发出时，时间线要如实显示它发出去了，而不是留一个「已取消」的谎话）；已 sent / failed 不动（重复事件）。
 * 同一 msgId 的入站回流行（#8 在 message_sent 之前先收到 message 事件时会插一行，clientMsgId 为 null）
 * 在同一事务里删掉合并 —— (groupId, msgId) 唯一，先删再写。
 */
export async function recordSent(
  messageId: string,
  landing: { msgId: string; sentAt: Date },
  deps: OutboxDeps = {},
): Promise<boolean> {
  const now = (deps.clock ?? systemClock).now();
  const applied = await getDb().$transaction(async (tx) => {
    const current = await tx.message.findUnique({ where: { id: messageId } });
    if (!current || current.deliveryStatus === null) return false;
    if (
      current.deliveryStatus === "sent" ||
      current.deliveryStatus === "failed"
    ) {
      return false;
    }
    await tx.message.deleteMany({
      where: {
        groupId: current.groupId,
        msgId: landing.msgId,
        clientMsgId: null,
        id: { not: messageId },
      },
    });
    await finishAttempt(tx, messageId, now, {
      httpStatus: null,
      errorCode: null,
    });
    const row = await settle(
      tx,
      messageId,
      null,
      ["queued", "accepted", "unknown", "cancelled"],
      {
        deliveryStatus: "sent",
        msgId: landing.msgId,
        sentAt: landing.sentAt,
        failCode: null,
        unknownSince: null,
        nextAttemptAt: null,
        lastError: null,
      },
      now,
    );
    return row !== null;
  });
  if (applied) {
    deps.log?.info({ messageId, msgId: landing.msgId }, "出站消息已发出");
  }
  return applied;
}

// ---- 派发：调网关 + 按 A2 错误表记账 -------------------------------------------------------

function backoffAt(now: Date, attempts: number): Date {
  const exp = Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKOFF_CAP_MS,
  );
  return new Date(now.getTime() + exp + randomInt(0, BACKOFF_JITTER_MS + 1));
}

/** 连不上里的哪些是「可能已发出」：请求已经出去了才超时 / 被重置；ECONNREFUSED 这类肯定没出去。 */
function isAmbiguousNetworkError(err: GatewayUnreachableError): boolean {
  const cause = err.cause as { name?: unknown; code?: unknown } | undefined;
  const name = typeof cause?.name === "string" ? cause.name : "";
  const code = typeof cause?.code === "string" ? cause.code : "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "ECONNRESET" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

function retryAfterOf(err: GatewayResponseError): number {
  const raw = (err.body as { retryAfterSeconds?: unknown } | null)
    ?.retryAfterSeconds;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_RATE_LIMIT_SECONDS;
}

/**
 * 领到的一条：调网关 send，按结果记账（表见文件头）。领取已 commit，这里的每一步都在事务之外，
 * 任何异常都不会让行停在「已领未记」—— 兜底分支把它放回 queued 退避（领取者若死在这里，回收步骤转 unknown）。
 */
export async function dispatchOne(
  msg: ClaimedMessage,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const { workerId, gateway, log } = deps;
  const ctx = {
    messageId: msg.id,
    clientMsgId: msg.clientMsgId,
    accountId: msg.accountId,
    groupId: msg.groupId,
    attempt: msg.attempts,
  };

  if (msg.gatewayGroupId === null) {
    await recordFailed(msg.id, workerId, "GROUP_UNREACHABLE", {}, deps);
    log?.warn(ctx, "群没有网关 groupId，出站消息 failed");
    return "failed";
  }

  try {
    await gateway.send({
      groupId: msg.gatewayGroupId,
      accountId: msg.accountId,
      clientMsgId: msg.clientMsgId,
      text: msg.text,
    });
  } catch (err) {
    return handleSendError(msg, err, ctx, deps);
  }

  const applied = await recordAccepted(msg.id, workerId, deps);
  log?.info(
    ctx,
    applied ? "网关已受理（accepted）" : "网关已受理，但该行已被级联取消",
  );
  return "accepted";
}

async function handleSendError(
  msg: ClaimedMessage,
  err: unknown,
  ctx: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const clock = deps.clock ?? systemClock;
  const { workerId, log } = deps;
  const now = clock.now();

  if (err instanceof GatewayResponseError) {
    const detail = err.body;

    // 429：账号 → rate_limited（已是则刷新截止），该行回 queued 到期再领；限流期内该账号一条都不领（claimBatch）
    if (err.status === 429 || err.code === "RATE_LIMITED") {
      const retryAfter = retryAfterOf(err);
      try {
        await enterRateLimited(msg.accountId, retryAfter, {
          clock,
          log,
          source: "send_error",
        });
      } catch (e) {
        // 账号已被操作员标成别的状态（idle / disconnected / 终态）：转移表不允许，只记日志；行照样回 queued
        if (!(e instanceof DomainError)) throw e;
        log?.warn(
          { ...ctx, err: e },
          "网关限流但本地账号状态不允许转 rate_limited",
        );
      }
      await requeue(
        msg.id,
        workerId,
        {
          nextAttemptAt: new Date(now.getTime() + retryAfter * 1000),
          httpStatus: 429,
          errorCode: err.code,
          detail,
        },
        deps,
      );
      log?.info({ ...ctx, retryAfter }, "网关限流，消息保持 queued 到期后发出");
      return "requeued";
    }

    // 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED：该行 cancelled + 账号进终态（级联其余 queued 行）
    const terminal = terminalFromGatewayError(err);
    if (terminal) {
      await recordCancelled(msg.id, workerId, err.code, err.status, deps);
      await enterTerminal(msg.accountId, terminal, "send_error", {
        clock,
        log,
      });
      log?.warn({ ...ctx, terminal }, "网关判账号终态，出站消息 cancelled");
      return "cancelled";
    }

    if (err.code === "GROUP_WRITE_FORBIDDEN") {
      await recordFailed(
        msg.id,
        workerId,
        err.code,
        { httpStatus: err.status, from: ["queued"] },
        deps,
      );
      await markGroupUnreachable(msg.groupId, err.code, { clock, log });
      log?.warn(ctx, "群不可写，出站消息 failed，群已 unreachable");
      return "failed";
    }

    if (err.status === 504 || err.code === NETWORK_TIMEOUT_CODE) {
      await recordUnknown(
        msg.id,
        workerId,
        { httpStatus: err.status, errorCode: NETWORK_TIMEOUT_CODE, detail },
        deps,
      );
      log?.warn(ctx, "网关 504，结果不明（unknown），等 by-client-id 确认");
      return "unknown";
    }

    if (err.status >= 500) {
      return backoffOrFail(
        msg,
        { httpStatus: err.status, errorCode: err.code, detail },
        ctx,
        deps,
      );
    }

    // 其余 4xx（SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE / 网关自定的 404 …）：明确拒绝，不重试
    await recordFailed(
      msg.id,
      workerId,
      err.code,
      { httpStatus: err.status, from: ["queued"] },
      deps,
    );
    log?.warn({ ...ctx, code: err.code }, "网关拒绝发送，出站消息 failed");
    return "failed";
  }

  if (err instanceof GatewayUnreachableError) {
    if (isAmbiguousNetworkError(err)) {
      await recordUnknown(
        msg.id,
        workerId,
        {
          httpStatus: null,
          errorCode: NETWORK_TIMEOUT_CODE,
          detail: String(err.cause),
        },
        deps,
      );
      log?.warn({ ...ctx, err }, "请求已发出但没拿到响应，结果不明（unknown）");
      return "unknown";
    }
    return backoffOrFail(
      msg,
      {
        httpStatus: null,
        errorCode: "GATEWAY_UNREACHABLE",
        detail: String(err.cause),
      },
      ctx,
      deps,
    );
  }

  // 编程错误 / 数据库错：不让行停在「已领未记」，退避后再试，错误原样进日志
  log?.error({ ...ctx, err }, "派发出站消息时异常");
  return backoffOrFail(
    msg,
    { httpStatus: null, errorCode: "INTERNAL", detail: String(err) },
    ctx,
    deps,
  );
}

async function backoffOrFail(
  msg: ClaimedMessage,
  result: { httpStatus: number | null; errorCode: string; detail?: unknown },
  ctx: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const now = (deps.clock ?? systemClock).now();
  if (msg.attempts >= MAX_ATTEMPTS) {
    await recordFailed(
      msg.id,
      deps.workerId,
      GATEWAY_UNAVAILABLE_FAIL_CODE,
      { httpStatus: result.httpStatus, from: ["queued"] },
      deps,
    );
    deps.log?.error({ ...ctx, ...result }, "重试耗尽，出站消息 failed");
    return "failed";
  }
  const nextAttemptAt = backoffAt(now, msg.attempts);
  await requeue(msg.id, deps.workerId, { nextAttemptAt, ...result }, deps);
  deps.log?.warn(
    { ...ctx, ...result, nextAttemptAt: nextAttemptAt.toISOString() },
    "网关不可用，退避后重试",
  );
  return "requeued";
}

// ---- unknown 的出路：by-client-id 确认 ------------------------------------------------------

/**
 * 每 tick 调。对每条 unknown 行查 by-client-id：
 * 200 → sent；404 且距 unknownSince 超过 2 秒 → 确认没发出：resendCount = 0 就用同一 clientMsgId 回 queued
 * （resendCount = 1，nextAttemptAt 空 → 本 tick 的领取就能发），否则 failed NETWORK_TIMEOUT；
 * 查询不可用（503 / 连不上）→ 保持 unknown，下个 tick 再看。
 */
export async function resolveUnknown(
  deps: DispatchDeps,
  limit: number = DEFAULT_BATCH_SIZE,
): Promise<ResolveUnknownStats> {
  const clock = deps.clock ?? systemClock;
  const { gateway, log } = deps;
  const stats: ResolveUnknownStats = {
    checked: 0,
    sent: 0,
    requeued: 0,
    failed: 0,
    pending: 0,
  };
  const rows = await getDb().message.findMany({
    where: { deliveryStatus: "unknown" },
    include: { group: { select: { gatewayGroupId: true } } },
    orderBy: [{ unknownSince: "asc" }, { id: "asc" }],
    take: limit,
  });
  for (const row of rows) {
    stats.checked += 1;
    const ctx = { messageId: row.id, clientMsgId: row.clientMsgId };
    if (row.clientMsgId === null || row.group.gatewayGroupId === null) {
      // 出站行必有 clientMsgId（CHECK 约束）；群没有网关 id 就没法确认，也不可能发出过
      await recordFailed(
        row.id,
        null,
        NETWORK_TIMEOUT_CODE,
        { from: ["unknown"] },
        deps,
      );
      stats.failed += 1;
      continue;
    }
    let landing: { msgId: string; sentAt: string } | null;
    try {
      landing = await gateway.getMessageByClientId(
        row.group.gatewayGroupId,
        row.clientMsgId,
      );
    } catch (err) {
      // 查询不可用 ≠ 没发出：保持 unknown
      log?.warn({ ...ctx, err }, "by-client-id 查询不可用，保持 unknown");
      stats.pending += 1;
      continue;
    }
    if (landing) {
      await recordSent(
        row.id,
        { msgId: landing.msgId, sentAt: new Date(landing.sentAt) },
        deps,
      );
      stats.sent += 1;
      continue;
    }
    const now = clock.now();
    const since = row.unknownSince ?? row.updatedAt;
    if (now.getTime() - since.getTime() <= UNKNOWN_CONFIRM_MS) {
      stats.pending += 1;
      continue;
    }
    if (row.resendCount === 0) {
      const changed = await getDb().$transaction(async (tx) => {
        const n = await tx.message.updateMany({
          where: { id: row.id, deliveryStatus: "unknown" },
          data: {
            deliveryStatus: "queued",
            resendCount: 1,
            unknownSince: null,
            nextAttemptAt: null,
            lastError: `${NETWORK_TIMEOUT_CODE}: 确认未发出，重发一次`,
          },
        });
        if (n.count > 0) {
          const fresh = await tx.message.findUniqueOrThrow({
            where: { id: row.id },
          });
          await emitMessageEvent(tx, fresh);
        }
        return n.count;
      });
      if (changed > 0) {
        log?.info(ctx, "确认未发出，用同一 clientMsgId 重发一次");
        stats.requeued += 1;
      }
      continue;
    }
    await recordFailed(
      row.id,
      null,
      NETWORK_TIMEOUT_CODE,
      { from: ["unknown"] },
      deps,
    );
    log?.warn(ctx, "重发后仍未发出，failed NETWORK_TIMEOUT");
    stats.failed += 1;
  }
  return stats;
}

// ---- 回收：领取者死了 ----------------------------------------------------------------------

/**
 * lockedAt 早于阈值仍 claimed 的 queued 行 = 领取者死在发出与记账之间，结果不明：转 unknown 走确认流程
 * （不直接放回 queued —— 那正是「一条记录对应两条消息」的来源）。领取时写的那行 outbound_attempts 以
 * errorCode = CLAIM_LOST 收口（httpStatus 为空 = 没拿到响应），账本里看得见这一次。
 */
export async function recoverStaleClaims(
  now: Date,
  deps: OutboxDeps = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const ids = await getDb().$transaction(async (tx) => {
    const stale = await tx.message.findMany({
      where: {
        deliveryStatus: "queued",
        claimedBy: { not: null },
        lockedAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (stale.length === 0) return [];
    await tx.outboundAttempt.updateMany({
      where: { messageId: { in: stale.map((s) => s.id) }, finishedAt: null },
      data: { finishedAt: now, httpStatus: null, errorCode: CLAIM_LOST_CODE },
    });
    await tx.message.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        deliveryStatus: "unknown",
        unknownSince: now,
        claimedBy: null,
        lockedAt: null,
        lastError: "领取后未记账（领取者可能死在发出与记账之间）",
      },
    });
    for (const s of stale) {
      const fresh = await tx.message.findUniqueOrThrow({ where: { id: s.id } });
      await emitMessageEvent(tx, fresh);
    }
    return stale.map((s) => s.id);
  });
  if (ids.length > 0) {
    deps.log?.warn({ messageIds: ids }, "回收过期领取：转 unknown 待确认");
  }
  return ids.length;
}

// ---- 入站事件的记账入口（#8 调）-------------------------------------------------------------

/**
 * message_sent { clientMsgId, msgId, sentAt } → sent；message_failed { clientMsgId, code } → failed + 与同名
 * 同步错误一样的后果（GROUP_WRITE_FORBIDDEN → 群 unreachable；ACCOUNT_SUSPENDED → 账号 suspended 级联）。
 * 幂等：重复事件（已是该终态）返回 applied = false；不认识的 clientMsgId 也是 false（不是我们发的，或已被清理）。
 */
export async function applyGatewayDelivery(
  input: GatewayDeliveryInput,
  deps: OutboxDeps = {},
): Promise<ApplyDeliveryResult> {
  const clock = deps.clock ?? systemClock;
  const db = getDb();
  const row = await db.message.findUnique({
    where: { clientMsgId: input.clientMsgId },
    select: { id: true, groupId: true, accountId: true, deliveryStatus: true },
  });
  if (!row) {
    deps.log?.warn(
      { clientMsgId: input.clientMsgId },
      "网关回执对应的出站消息不存在",
    );
    return { applied: false, status: null };
  }

  if (input.msgId !== undefined) {
    const parsed =
      input.sentAt === undefined ? clock.now() : new Date(input.sentAt);
    const sentAt = Number.isNaN(parsed.getTime()) ? clock.now() : parsed;
    const applied = await recordSent(
      row.id,
      { msgId: input.msgId, sentAt },
      deps,
    );
    return { applied, status: applied ? "sent" : row.deliveryStatus };
  }

  const code = input.code ?? "UNKNOWN";
  const applied = await recordFailed(row.id, null, code, {}, deps);
  if (applied) {
    deps.log?.warn(
      { clientMsgId: input.clientMsgId, code },
      "网关 message_failed，出站消息 failed",
    );
    if (code === "GROUP_WRITE_FORBIDDEN") {
      await markGroupUnreachable(row.groupId, code, { clock, log: deps.log });
    } else if (code === "ACCOUNT_SUSPENDED" && row.accountId !== null) {
      await enterTerminal(row.accountId, "suspended", "gateway_event", {
        clock,
        log: deps.log,
      });
    } else if (code === "SESSION_EXPIRED" && row.accountId !== null) {
      await enterTerminal(row.accountId, "session_expired", "gateway_event", {
        clock,
        log: deps.log,
      });
    }
  }
  return { applied, status: applied ? "failed" : row.deliveryStatus };
}
