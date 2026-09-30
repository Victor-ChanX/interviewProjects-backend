// 健康检查：无闸门（要在地图脚本 PUBLIC_ENDPOINTS 里登记 "GET /api/health"）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { HealthRead } from "../../schemas/health.js";

export default async function healthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/health",
    {
      schema: {
        summary: "健康检查",
        tags: ["health"],
        response: { 200: HealthRead },
      },
    },
    async () => ({ status: "ok" as const, time: new Date().toISOString() }),
  );
}
