// 工作台概览端点（#22：GET /api/dashboard/summary）。HTTP 边界：声明路由 + zod schema + 闸门，
// 计数在 src/services/dashboard-service.ts（同一个只读事务、按 ?timeZone= 的「今日」）。读走 requireUser（viewer 可看）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { DashboardQuery, DashboardSummary } from "../../schemas/dashboard.js";
import { getDashboardSummary } from "../../services/dashboard-service.js";
import { requireUser } from "../guards.js";

export default async function dashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/dashboard/summary",
    {
      onRequest: [requireUser],
      schema: {
        summary:
          "工作台概览：账号 / 群 / 今日消息 / Agent 运行 / 序列 / job / 待处理异常的计数（今日按 timeZone 参数的自然日，默认 UTC）",
        tags: ["dashboard"],
        querystring: DashboardQuery,
        response: { 200: DashboardSummary },
      },
    },
    async (req) => getDashboardSummary({ timeZone: req.query.timeZone }),
  );
}
