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

const CheckState = z.enum(["ok", "fail"]).meta({ id: "ReadinessCheckState" });

/** 就绪检查（#57）：200 时各项都是 ok；不就绪是 503 NOT_READY 错误信封，extra.checks 同形 */
export const ReadinessRead = z
  .object({
    ok: z.literal(true),
    checks: z.object({
      database: CheckState,
      schema: CheckState,
      scheduler: CheckState,
    }),
  })
  .meta({ id: "ReadinessRead" });
