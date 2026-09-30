// 发消息：send 的同步错误全套、202 受理后的落地（message_sent + 回流的 message）或 message_failed、
// by-client-id 查询、外部用户消息、离线补投。
//
// 题目 2.1「发消息」逐条：202 { accepted: true }（可能一两秒才回）；随后 message_sent { clientMsgId, msgId,
// sentAt } 或 message_failed { clientMsgId, code }；同步错误 429 RATE_LIMITED { retryAfterSeconds }（期内重复
// 429 且计时重置）/ 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED（终态）/ 403 GROUP_WRITE_FORBIDDEN /
// 403 SENDER_NOT_IN_GROUP / 409 ACCOUNT_OFFLINE / 504 NETWORK_TIMEOUT（可能已发出：2 秒内落地并推 message_sent）。
// 不按 clientMsgId 去重：同一个 clientMsgId 发两次就是两条。by-client-id 返回最早的一条。
// 服务账号自己发出的消息也作为 message 事件推回（msgId 与 message_sent 一致）。
//
// 检查顺序：账号终态 → 限流 → 离线 → 群存在 → 群不可写 → 不在群 → 场景固定响应 → 202。
// 场景固定响应排在自然状态之后：脚本只在「本来会成功」的调用上生效，副作用与同名同步错误一致。
import { randomBytes } from "node:crypto";

import {
  assertNotRateLimited,
  assertOnline,
  rateLimit,
  setTerminalStatus,
} from "./accounts.js";
import { GatewayError } from "./errors.js";
import { emit } from "./events.js";
import { getGroup } from "./groups.js";
import type { SendResponse } from "./scenario.js";
import {
  type Account,
  type GatewayContext,
  type Group,
  nowMs,
  type StoredMessage,
} from "./state.js";

export interface SendInput {
  groupId: string;
  accountId: string;
  clientMsgId: string;
  text: string;
}

export async function send(
  ctx: GatewayContext,
  input: SendInput,
): Promise<{ accepted: true }> {
  const { groupId, accountId, clientMsgId } = input;
  const record = (status: number, code: string | null): void => {
    ctx.sendCalls.push({ accountId, groupId, clientMsgId, status, code });
  };
  try {
    const account = assertOnline(ctx, accountId);
    assertNotRateLimited(ctx, account);
    const group = getGroup(ctx, groupId);
    assertWritable(group);
    if (!group.members.has(account.platformUserId)) {
      throw new GatewayError(
        403,
        "SENDER_NOT_IN_GROUP",
        `账号 ${accountId} 不在群 ${groupId} 里`,
      );
    }

    const scripted = takeScriptedResponse(ctx, accountId, clientMsgId);
    if (scripted && scripted.status !== 202) {
      throw applyScriptedResponse(ctx, account, group, input, scripted);
    }

    await ctx.timers.sleep(ctx.rng.fromRange(ctx.scenario.send.acceptDelayMs));
    scheduleOutcome(ctx, account, group, input);
    record(202, null);
    return { accepted: true };
  } catch (err) {
    if (err instanceof GatewayError) record(err.statusCode, err.code);
    throw err;
  }
}

function assertWritable(group: Group): void {
  if (group.writeForbidden) {
    throw new GatewayError(
      403,
      "GROUP_WRITE_FORBIDDEN",
      `群 ${group.groupId} 不可写（已解散或被禁言）`,
    );
  }
}

/** 取队列里第一条匹配本次调用的脚本响应并移除；没有则 undefined。 */
function takeScriptedResponse(
  ctx: GatewayContext,
  accountId: string,
  clientMsgId: string,
): SendResponse | undefined {
  const queue = ctx.scenario.send.responses;
  const index = queue.findIndex(
    (r) =>
      (r.match?.accountId === undefined || r.match.accountId === accountId) &&
      (r.match?.clientMsgId === undefined ||
        r.match.clientMsgId === clientMsgId),
  );
  if (index < 0) return undefined;
  const [taken] = queue.splice(index, 1);
  return taken;
}

/** 脚本响应的状态副作用与同名同步错误一致；返回要抛的错误。 */
function applyScriptedResponse(
  ctx: GatewayContext,
  account: Account,
  group: Group,
  input: SendInput,
  scripted: SendResponse,
): GatewayError {
  switch (scripted.status) {
    case 429:
      return rateLimit(ctx, account, scripted.retryAfterSeconds);
    case 403:
      if (scripted.code === "ACCOUNT_SUSPENDED") {
        setTerminalStatus(ctx, account.accountId, "suspended", {
          pushEvent: scripted.pushStatusEvent,
        });
        return new GatewayError(
          403,
          "ACCOUNT_SUSPENDED",
          `账号 ${account.accountId} 已被平台停用`,
        );
      }
      if (scripted.code === "GROUP_WRITE_FORBIDDEN") {
        group.writeForbidden = true;
        return new GatewayError(
          403,
          "GROUP_WRITE_FORBIDDEN",
          `群 ${group.groupId} 不可写（已解散或被禁言）`,
        );
      }
      return new GatewayError(
        403,
        "SENDER_NOT_IN_GROUP",
        `账号 ${account.accountId} 不在群 ${group.groupId} 里`,
      );
    case 401:
      setTerminalStatus(ctx, account.accountId, "session_expired", {
        pushEvent: scripted.pushStatusEvent,
      });
      return new GatewayError(
        401,
        "SESSION_EXPIRED",
        `账号 ${account.accountId} 的会话已失效`,
      );
    case 409:
      return new GatewayError(
        409,
        "ACCOUNT_OFFLINE",
        `账号 ${account.accountId} 未 connect 或已 disconnect`,
      );
    case 504:
      if (scripted.landAfterMs !== null) {
        ctx.timers.schedule(scripted.landAfterMs, () =>
          landMessage(ctx, account, group, input),
        );
      }
      return new GatewayError(
        504,
        "NETWORK_TIMEOUT",
        "send 超时，结果未知；请用 by-client-id 查询（2 秒内落地或确定没发出）",
      );
    case 503:
      return new GatewayError(503, "SERVICE_UNAVAILABLE", "网关暂时不可用");
    default:
      return new GatewayError(500, "INTERNAL", "未知的脚本响应");
  }
}

/** 202 之后：按场景 outcome 在 eventDelayMs 后落地或失败。 */
function scheduleOutcome(
  ctx: GatewayContext,
  account: Account,
  group: Group,
  input: SendInput,
): void {
  const { outcome, eventDelayMs } = ctx.scenario.send;
  ctx.timers.schedule(ctx.rng.fromRange(eventDelayMs), () => {
    if (outcome === "sent") {
      landMessage(ctx, account, group, input);
      return;
    }
    const code = outcome.slice("failed:".length);
    // message_failed 的含义与同名同步错误相同：账号停用 / 群不可写也真的发生。
    if (code === "ACCOUNT_SUSPENDED") {
      setTerminalStatus(ctx, account.accountId, "suspended", {
        pushEvent: false,
      });
    } else {
      group.writeForbidden = true;
    }
    emit(ctx, "message_failed", { clientMsgId: input.clientMsgId, code });
  });
}

/** 消息落地：记入 messages（by-client-id 可查）、推 message_sent，再按场景把它作为 message 事件回流。 */
export function landMessage(
  ctx: GatewayContext,
  account: Account,
  group: Group,
  input: SendInput,
): StoredMessage {
  const message: StoredMessage = {
    msgId: `msg_${randomBytes(8).toString("hex")}`,
    groupId: group.groupId,
    clientMsgId: input.clientMsgId,
    senderPlatformUserId: account.platformUserId,
    text: input.text,
    sentAt: ctx.clock.now().toISOString(),
  };
  ctx.messages.push(message);
  emit(ctx, "message_sent", {
    clientMsgId: message.clientMsgId,
    msgId: message.msgId,
    sentAt: message.sentAt,
  });
  if (ctx.scenario.send.echoOwnMessage) emitMessageEvent(ctx, message);
  return message;
}

export function emitMessageEvent(
  ctx: GatewayContext,
  message: StoredMessage,
): void {
  emit(ctx, "message", {
    groupId: message.groupId,
    msgId: message.msgId,
    senderPlatformUserId: message.senderPlatformUserId,
    text: message.text,
    sentAt: message.sentAt,
    ...(message.mediaUrl !== undefined ? { mediaUrl: message.mediaUrl } : {}),
  });
}

/** GET /groups/:groupId/messages/by-client-id/:clientMsgId：最早落地的一条；没有 → 404。 */
export function findByClientId(
  ctx: GatewayContext,
  groupId: string,
  clientMsgId: string,
): { msgId: string; sentAt: string } {
  const found = ctx.messages.find(
    (m) => m.groupId === groupId && m.clientMsgId === clientMsgId,
  );
  if (!found) {
    throw new GatewayError(
      404,
      "NOT_FOUND",
      `群 ${groupId} 里没有 clientMsgId=${clientMsgId} 的已落地消息`,
    );
  }
  return { msgId: found.msgId, sentAt: found.sentAt };
}

/** POST /_sim/push { kind: "message" }：外部用户（或任意 platformUserId）往群里发一条消息。 */
export function pushExternalMessage(
  ctx: GatewayContext,
  input: {
    groupId: string;
    senderPlatformUserId?: string;
    text: string;
    sentAt?: string;
    media?: { contentType: string; base64: string; expiresAfterMs?: number };
  },
): StoredMessage {
  getGroup(ctx, input.groupId);
  const message: StoredMessage = {
    msgId: `msg_${randomBytes(8).toString("hex")}`,
    groupId: input.groupId,
    clientMsgId: null,
    senderPlatformUserId:
      input.senderPlatformUserId ?? `ext_${randomBytes(4).toString("hex")}`,
    text: input.text,
    sentAt: input.sentAt ?? ctx.clock.now().toISOString(),
  };
  if (input.media) {
    const id = randomBytes(8).toString("hex");
    ctx.media.set(id, {
      id,
      contentType: input.media.contentType,
      bytes: Buffer.from(input.media.base64, "base64"),
      expiresAt:
        input.media.expiresAfterMs === undefined
          ? null
          : nowMs(ctx) + input.media.expiresAfterMs,
    });
    message.mediaUrl = `${ctx.publicUrl}/media/${id}`;
  }
  ctx.messages.push(message);
  emitMessageEvent(ctx, message);
  return message;
}

/**
 * POST /_sim/push { kind: "redeliver" }：离线补投 —— 同一条消息再推一次 message 事件，
 * eventId 是新的（更大），msgId / sentAt 为原值。
 */
export function redeliver(ctx: GatewayContext, msgId: string): StoredMessage {
  const message = ctx.messages.find((m) => m.msgId === msgId);
  if (!message) {
    throw new GatewayError(404, "NOT_FOUND", `没有 msgId=${msgId} 的消息`);
  }
  emitMessageEvent(ctx, message);
  return message;
}

/** GET /media/:id：文件字节；过期或不存在 → 404。 */
export function readMedia(
  ctx: GatewayContext,
  id: string,
): { contentType: string; bytes: Buffer } {
  const media = ctx.media.get(id);
  if (!media || (media.expiresAt !== null && nowMs(ctx) >= media.expiresAt)) {
    throw new GatewayError(404, "NOT_FOUND", `媒体 ${id} 不存在或已过期`);
  }
  return { contentType: media.contentType, bytes: media.bytes };
}
