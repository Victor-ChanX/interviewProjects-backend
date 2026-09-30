// 群消息时间线端点（题目 2.3 `GET /api/groups/:id/messages`；issue #9）。HTTP 边界：声明路由 + zod schema + 闸门，
// 查询在 src/services/message-service.ts。读走 requireUser（viewer 可看）。
// 游标分页 { items, nextCursor }：before 是上一页的 nextCursor，limit 默认 50、上限 200（schema 钳）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  GroupIdParams,
  MessageListQuery,
  MessagePage,
} from "../../schemas/message.js";
import { listMessages } from "../../services/message-service.js";
import { requireUser } from "../guards.js";

export default async function groupMessageRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/:id/messages",
    {
      onRequest: [requireUser],
      schema: {
        summary:
          "群消息时间线：按 sentAt 倒序，游标分页（before = 上一页的 nextCursor）",
        tags: ["messages"],
        params: GroupIdParams,
        querystring: MessageListQuery,
        response: { 200: MessagePage },
      },
    },
    async (req) =>
      listMessages(req.params.id, {
        before: req.query.before,
        limit: req.query.limit,
      }),
  );
}
