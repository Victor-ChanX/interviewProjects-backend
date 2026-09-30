// 健康检查：无闸门（在地图脚本 PUBLIC_ENDPOINTS 里登记了 "GET /api/health" 与 "GET /api/health/ready"）。
// /api/health 是探活（进程活着、跑的是哪版 schema，不碰依赖）；/api/health/ready 是就绪（数据库、schema、worker 心跳）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { HealthRead, ReadinessRead } from "../../schemas/health.js";
import {
  checkReadiness,
  getSchemaVersion,
} from "../../services/health-service.js";

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

  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/health/ready",
    {
      schema: {
        summary:
          "就绪检查：数据库可查、迁移状态与代码一致、后台 worker 在跳心跳；不就绪 503 NOT_READY",
        tags: ["health"],
        response: { 200: ReadinessRead },
      },
    },
    async () => ({
      ok: true as const,
      checks: await checkReadiness(new Date()),
    }),
  );
}
