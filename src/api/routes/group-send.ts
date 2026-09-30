// 发消息端点（题目 2.3 `POST /api/groups/:id/send`；issue #7）。HTTP 边界：声明路由 + zod schema + 闸门，
// 不写查询、不 import src/db。写操作走 requireRole("admin")：viewer 403（A0）。
//
// 202 = 出站记录已落库（queued），真正发出由出站 worker（src/workers/outbox-worker.ts）派发，
// 状态在 GET /api/groups/:id/messages 的 deliveryStatus 里看（#9）。拒绝：群不存在 404 GROUP_NOT_FOUND、
// 群不可写 409 GROUP_UNREACHABLE、账号不在群 409 ACCOUNT_NOT_IN_GROUP、账号不可用 409 ACCOUNT_UNAVAILABLE ——
// 都由 service throw，信封由 src/app.ts 统一产出。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  GroupIdParams,
  SendRequest,
  SendResponse,
} from "../../schemas/message.js";
import { enqueueMessage } from "../../services/outbox-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function groupSendRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/:id/send",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "以某服务账号身份往群里发一条消息（入队，202）",
        tags: ["groups"],
        params: GroupIdParams,
        body: SendRequest,
        response: { 202: SendResponse },
      },
    },
    async (req, reply) => {
      const { clientMsgId } = await enqueueMessage(
        {
          groupId: req.params.id,
          accountId: req.body.accountId,
          text: req.body.text,
          source: "operator",
        },
        { log: req.log },
      );
      return reply.code(202).send({ clientMsgId });
    },
  );
}
