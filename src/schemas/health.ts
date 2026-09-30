import { z } from "zod";

// 响应必须有 properties（openapi 审计 BARE_OBJECT_RESPONSE 会拦裸 object）。
export const HealthRead = z
  .object({
    status: z.literal("ok"),
    time: z.iso.datetime(),
  })
  .meta({ id: "HealthRead" });
export type HealthRead = z.infer<typeof HealthRead>;
