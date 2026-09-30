// 题目 2.1 的公开端点（被应用当作外部网关调用的那些）。只做参数解析与调用领域模块；
// 拒绝一律 throw GatewayError，由 app.ts 的 setErrorHandler 序列化成 { code, message }。
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { connect, disconnect } from "./accounts.js";
import { parseBody } from "./admin.js";
import { GatewayError } from "./errors.js";
import { attachStream } from "./events.js";
import {
  createGroup,
  createInvite,
  join,
  kick,
  leave,
  listMembers,
  promote,
} from "./groups.js";
import { findByClientId, readMedia, send } from "./messages.js";
import type { GatewayContext } from "./state.js";

const id = z.string().min(1);

const accountParams = z.object({ accountId: id });
const groupParams = z.object({ groupId: id });
const byClientIdParams = z.object({ groupId: id, clientMsgId: id });
const mediaParams = z.object({ id });

const createGroupBody = z.object({ creatorAccountId: id });
const joinBody = z.object({ accountId: id, inviteLink: id });
const promoteBody = z.object({ byAccountId: id, accountId: id });
const kickBody = z.object({ byAccountId: id, targetPlatformUserId: id });
const leaveBody = z.object({ accountId: id });
const sendBody = z.object({ accountId: id, clientMsgId: id, text: z.string() });
const eventsQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
});

export function registerGatewayRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
): void {
  // ---- 账号 ----
  app.post("/accounts/:accountId/connect", async (req) => {
    const { accountId } = parseBody(accountParams, req.params);
    return connect(ctx, accountId);
  });
  app.post("/accounts/:accountId/disconnect", async (req) => {
    const { accountId } = parseBody(accountParams, req.params);
    disconnect(ctx, accountId);
    return {};
  });

  // ---- 群与成员 ----
  app.post("/groups", async (req) => {
    const { creatorAccountId } = parseBody(createGroupBody, req.body);
    return createGroup(ctx, creatorAccountId);
  });
  app.post("/groups/:groupId/invite", async (req) => {
    const { groupId } = parseBody(groupParams, req.params);
    return createInvite(ctx, groupId);
  });
  app.post("/groups/:groupId/join", async (req, reply) => {
    const { groupId } = parseBody(groupParams, req.params);
    const { accountId, inviteLink } = parseBody(joinBody, req.body);
    const result = join(ctx, groupId, accountId, inviteLink);
    return reply.code(202).send(result);
  });
  app.post("/groups/:groupId/promote", async (req) => {
    const { groupId } = parseBody(groupParams, req.params);
    const { byAccountId, accountId } = parseBody(promoteBody, req.body);
    return promote(ctx, groupId, byAccountId, accountId);
  });
  app.post("/groups/:groupId/kick", async (req) => {
    const { groupId } = parseBody(groupParams, req.params);
    const { byAccountId, targetPlatformUserId } = parseBody(kickBody, req.body);
    return kick(ctx, groupId, byAccountId, targetPlatformUserId);
  });
  app.post("/groups/:groupId/leave", async (req) => {
    const { groupId } = parseBody(groupParams, req.params);
    const { accountId } = parseBody(leaveBody, req.body);
    return leave(ctx, groupId, accountId);
  });
  app.get("/groups/:groupId/members", async (req) => {
    const { groupId } = parseBody(groupParams, req.params);
    return listMembers(ctx, groupId);
  });

  // ---- 发消息 ----
  app.post("/groups/:groupId/send", async (req, reply) => {
    const { groupId } = parseBody(groupParams, req.params);
    const body = parseBody(sendBody, req.body);
    const result = await send(ctx, { groupId, ...body });
    return reply.code(202).send(result);
  });
  app.get(
    "/groups/:groupId/messages/by-client-id/:clientMsgId",
    async (req) => {
      const { groupId, clientMsgId } = parseBody(byClientIdParams, req.params);
      return findByClientId(ctx, groupId, clientMsgId);
    },
  );
  app.get("/media/:id", async (req, reply) => {
    const params = parseBody(mediaParams, req.params);
    const media = readMedia(ctx, params.id);
    return reply.header("content-type", media.contentType).send(media.bytes);
  });

  // ---- 事件流（SSE）----
  // hijack 后由 events.ts 直接写 reply.raw；连接由客户端断开或场景掐断。
  app.get("/events", async (req, reply) => {
    const { since } = parseBody(eventsQuery, req.query);
    reply.hijack();
    attachStream(ctx, reply.raw, since ?? null);
  });

  app.setNotFoundHandler(async () => {
    throw new GatewayError(404, "NOT_FOUND", "没有这个端点");
  });
}
