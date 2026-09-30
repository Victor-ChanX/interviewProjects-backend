// 最近动态端点（#22：GET /api/activity）。HTTP 边界：声明路由 + zod schema + 闸门，查询在
// src/services/activity-service.ts。读走 requireUser（viewer 可看）。游标分页 { items, nextCursor }（按 seq 倒序）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { ActivityListQuery, ActivityPage } from "../../schemas/activity.js";
import { listActivity } from "../../services/activity-service.js";
import { requireUser } from "../guards.js";

export default async function activityRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/activity",
    {
      preHandler: [requireUser],
      schema: {
        summary:
          "最近动态：WS 事件（白名单类型）按 seq 倒序，游标分页；首屏用它，之后靠 WS 追加",
        tags: ["activity"],
        querystring: ActivityListQuery,
        response: { 200: ActivityPage },
      },
    },
    async (req) =>
      listActivity({ before: req.query.before, limit: req.query.limit }),
  );
}
