// 异常中心（#22；题目 A2「写库失败 … 推 inconsistency 事件，让操作员看到」）的 zod schema。
// 列表项不带 payload（事件原文可能很大），详情 GET /api/inconsistencies/:id 才带。
// kind 不做成 enum：取值由各写入方定义（inbound_event_failed / inbound_unknown_group / leave_all_members_mismatch …），
// 新增类别不该让读端点 500；前端按已知值映射文案、未知值原样显示。
import { z } from "zod";

export const InconsistencyRead = z
  .object({
    id: z.string(),
    kind: z.string(),
    /** 关联对象引用（eventId / clientMsgId / jobId …），无则 null */
    ref: z.string().nullable(),
    message: z.string(),
    createdAt: z.iso.datetime(),
    /** 标记已处理的时刻；未处理为 null */
    resolvedAt: z.iso.datetime().nullable(),
    /** 标记已处理的登录用户名；未处理为 null */
    resolvedBy: z.string().nullable(),
  })
  .meta({ id: "InconsistencyRead" });
export type InconsistencyRead = z.infer<typeof InconsistencyRead>;

/** 详情 = 列表项 + payload（写入方存的原文 / 上下文，如网关事件原文；没有为 null） */
export const InconsistencyDetail = InconsistencyRead.extend({
  payload: z.record(z.string(), z.unknown()).nullable(),
}).meta({ id: "InconsistencyDetail" });
export type InconsistencyDetail = z.infer<typeof InconsistencyDetail>;

export const InconsistencyIdParams = z.object({ id: z.string().min(1) });

/** 列表的 resolved 筛选值（query 是字符串；具名 enum 让前端派生出 "true" | "false"） */
export const InconsistencyResolvedFilter = z
  .enum(["true", "false"])
  .meta({ id: "InconsistencyResolvedFilter" });

/**
 * `?resolved=false|true&before=&limit=`：resolved 不给 = 全部；before 是上一页的 nextCursor（不透明），
 * limit 默认 50、上限 200。按 createdAt、id 倒序。
 */
export const InconsistencyListQuery = z.object({
  resolved: InconsistencyResolvedFilter.optional(),
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type InconsistencyListQuery = z.infer<typeof InconsistencyListQuery>;

/** 游标分页 `{ items, nextCursor }`。命名为 *Page 而不是 *ListResponse：后者的审计要求 items + total（同 MessagePage） */
export const InconsistencyPage = z
  .object({
    items: z.array(InconsistencyRead),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "InconsistencyPage" });
export type InconsistencyPage = z.infer<typeof InconsistencyPage>;
