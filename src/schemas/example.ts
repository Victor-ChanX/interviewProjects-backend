// zod 请求 / 响应 schema。Read 模型要可派生：枚举用具名 schema（.meta({ id })
// 进 openapi components），响应字段不带 default，时间是 ISO 8601 UTC 字符串。
import { z } from "zod";

export const ExampleStatus = z
  .enum(["active", "archived"])
  .meta({ id: "ExampleStatus" });
export type ExampleStatus = z.infer<typeof ExampleStatus>;

export const ExampleRead = z
  .object({
    id: z.number().int(),
    name: z.string(),
    status: ExampleStatus,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "ExampleRead" });
export type ExampleRead = z.infer<typeof ExampleRead>;

export const ExampleListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});
export type ExampleListQuery = z.infer<typeof ExampleListQuery>;

export const ExampleListResponse = z
  .object({
    items: z.array(ExampleRead),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: "ExampleListResponse" });
export type ExampleListResponse = z.infer<typeof ExampleListResponse>;

export const ExampleIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

export const ExampleCreate = z.object({
  name: z.string().min(1).max(100),
});
export type ExampleCreate = z.infer<typeof ExampleCreate>;
