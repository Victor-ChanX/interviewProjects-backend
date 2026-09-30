// 管理端点（/_sim/*）：场景脚本、重置、状态快照、手动推事件、掐断 SSE、让邀请过期。
// 这些端点不受 outage（503）影响 —— 它们是测试的控制面，不是被模拟的网关。
//
//   GET  /_sim/scenario            当前场景
//   POST /_sim/scenario            打补丁（按节浅合并，见 scenario.ts），返回合并后的完整场景
//   POST /_sim/reset               清空账号 / 群 / 消息 / 事件 / 定时器，场景恢复默认，掐断 SSE
//   GET  /_sim/state               成员 / 消息 / 事件计数等（供测试断言「网关里恰好一条」）
//   POST /_sim/push                手动推事件：message / member_joined / member_left / account_status / redeliver / raw
//   POST /_sim/streams/disconnect  掐断所有 SSE 连接
//   POST /_sim/invites/expire      让某条（或全部）邀请链接立刻过期
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { setTerminalStatus } from "./accounts.js";
import { GatewayError } from "./errors.js";
import { disconnectStreams, emit } from "./events.js";
import { addMember, expireInvites, getGroup, removeMember } from "./groups.js";
import { pushExternalMessage, redeliver } from "./messages.js";
import { applyScenarioPatch, scenarioPatchSchema } from "./scenario.js";
import { type GatewayContext, resetContext } from "./state.js";

const pushSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    groupId: z.string().min(1),
    senderPlatformUserId: z.string().min(1).optional(),
    text: z.string(),
    sentAt: z.string().datetime({ offset: true }).optional(),
    media: z
      .object({
        contentType: z.string().min(1),
        base64: z.string(),
        expiresAfterMs: z.number().int().min(0).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("member_joined"),
    groupId: z.string().min(1),
    platformUserId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("member_left"),
    groupId: z.string().min(1),
    platformUserId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("account_status"),
    accountId: z.string().min(1),
    status: z.enum(["suspended", "session_expired"]),
  }),
  z.object({ kind: z.literal("redeliver"), msgId: z.string().min(1) }),
  z.object({
    kind: z.literal("raw"),
    type: z.enum([
      "message",
      "message_sent",
      "message_failed",
      "member_joined",
      "member_left",
      "account_status",
    ]),
    data: z.record(z.string(), z.unknown()),
  }),
]);

const expireSchema = z.object({ inviteLink: z.string().min(1).optional() });

export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new GatewayError(400, "BAD_REQUEST", "请求体不合法", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

export function snapshot(ctx: GatewayContext): Record<string, unknown> {
  const byType: Record<string, number> = {};
  for (const e of ctx.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return {
    now: ctx.clock.now().toISOString(),
    scenario: ctx.scenario,
    accounts: [...ctx.accounts.values()].map((a) => ({
      ...a,
      rateLimitedUntil:
        a.rateLimitedUntil === null
          ? null
          : new Date(a.rateLimitedUntil).toISOString(),
    })),
    groups: [...ctx.groups.values()].map((g) => ({
      groupId: g.groupId,
      ownerAccountId: g.ownerAccountId,
      ownerPlatformUserId: g.ownerPlatformUserId,
      ownerLeft: g.ownerLeft,
      writeForbidden: g.writeForbidden,
      members: [...g.members.values()],
      pendingJoins: [...g.pendingJoins],
    })),
    invites: [...ctx.invites.values()].map((i) => ({
      ...i,
      readyAt: new Date(i.readyAt).toISOString(),
      expiresAt:
        i.expiresAt === null ? null : new Date(i.expiresAt).toISOString(),
    })),
    messages: ctx.messages,
    sendCalls: ctx.sendCalls,
    promoteCalls: ctx.promoteCalls,
    leaveCalls: ctx.leaveCalls,
    events: {
      count: ctx.events.length,
      lastEventId: ctx.eventSeq,
      byType,
      items: ctx.events,
    },
    streams: { open: ctx.streams.size },
    pendingTimers: ctx.timers.pending(),
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
): void {
  app.get("/_sim/scenario", async () => ctx.scenario);

  app.post("/_sim/scenario", async (req) => {
    const patch = parseBody(scenarioPatchSchema, req.body);
    ctx.scenario = applyScenarioPatch(ctx.scenario, patch);
    // 群不可写名单是场景的一部分：已存在的群按新名单同步。
    for (const group of ctx.groups.values()) {
      if (ctx.scenario.groups.writeForbidden.includes(group.groupId)) {
        group.writeForbidden = true;
      }
    }
    return ctx.scenario;
  });

  app.post("/_sim/reset", async () => {
    disconnectStreams(ctx);
    resetContext(ctx);
    return { ok: true };
  });

  app.get("/_sim/state", async () => snapshot(ctx));

  app.post("/_sim/push", async (req) => {
    const body = parseBody(pushSchema, req.body);
    const before = ctx.eventSeq;
    switch (body.kind) {
      case "message":
        pushExternalMessage(ctx, body);
        break;
      case "member_joined":
        addMember(ctx, getGroup(ctx, body.groupId), body.platformUserId);
        break;
      case "member_left":
        removeMember(ctx, getGroup(ctx, body.groupId), body.platformUserId);
        break;
      case "account_status":
        setTerminalStatus(ctx, body.accountId, body.status, {
          pushEvent: true,
        });
        break;
      case "redeliver":
        redeliver(ctx, body.msgId);
        break;
      case "raw":
        emit(ctx, body.type, body.data);
        break;
    }
    const eventIds = ctx.events
      .filter((e) => e.eventId > before)
      .map((e) => e.eventId);
    return { eventIds };
  });

  app.post("/_sim/streams/disconnect", async () => ({
    disconnected: disconnectStreams(ctx),
  }));

  app.post("/_sim/invites/expire", async (req) => {
    const { inviteLink } = parseBody(expireSchema, req.body);
    return { expired: expireInvites(ctx, inviteLink) };
  });
}
