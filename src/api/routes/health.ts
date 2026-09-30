// 健康检查：无闸门（在地图脚本 PUBLIC_ENDPOINTS 里登记了 "GET /api/health"）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { HealthRead } from "../../schemas/health.js";
import { getSchemaVersion } from "../../services/health-service.js";

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
    async () => ({ ok: true as const, schemaVersion: getSchemaVersion() }),
  );
}
