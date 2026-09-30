import { z } from "zod";

// 题目 2.3：GET /api/health → { ok, schemaVersion }。
// 响应必须有 properties（openapi 审计 BARE_OBJECT_RESPONSE 会拦裸 object）。
export const HealthRead = z
  .object({
    ok: z.literal(true),
    /** 迁移链最新一条的目录名（见 src/services/health-service.ts） */
    schemaVersion: z.string(),
  })
  .meta({ id: "HealthRead" });
export type HealthRead = z.infer<typeof HealthRead>;
