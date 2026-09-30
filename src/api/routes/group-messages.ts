// 群消息时间线端点（题目 2.3 `GET /api/groups/:id/messages`；issue #9）。HTTP 边界：声明路由 + zod schema + 闸门，
// 查询在 src/services/message-service.ts。读走 requireUser（viewer 可看）。
// 游标分页 { items, nextCursor }：before 是上一页的 nextCursor，limit 默认 50、上限 200（schema 钳）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  GroupIdParams,
  GroupMessageParams,
  MessageListQuery,
  MessagePage,
} from "../../schemas/message.js";
import { readMessageMedia } from "../../services/media-service.js";
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

  // 附件文件（#59，题目 C1 下载到本地的那份）：二进制响应，不声明 JSON schema；没有可看的 → 404 MEDIA_NOT_AVAILABLE
  r.get(
    "/:id/messages/:msgId/media",
    {
      onRequest: [requireUser],
      schema: {
        summary: "取一条消息已下载到本地的附件文件（题目 C1）",
        tags: ["messages"],
        params: GroupMessageParams,
      },
    },
    async (req, reply) => {
      const { bytes, contentType } = await readMessageMedia(
        req.params.id,
        req.params.msgId,
      );
      return reply
        .header("content-type", contentType)
        .header("cache-control", "private, max-age=86400")
        .send(bytes);
    },
  );
}
