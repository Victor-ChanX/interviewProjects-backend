// 最近动态（#22：GET /api/activity）的 zod schema：ws_events 的只读视图，前端「实时动态」首屏用它，之后靠 WS 追加
// （WS 帧同形 { seq, type, payload }，按 seq 去重）。
import { z } from "zod";

/**
 * 下发的事件类型白名单（src/services/ws-events.ts 的 WS_EVENT_TYPES 的子集；service 里用类型约束两边一致）。
 * 不在白名单的类型（如 inconsistency_resolved 这类操作回执）不进动态流。
 */
export const ActivityEventType = z
  .enum([
    "account_status_changed",
    "account_terminal",
    "inconsistency",
    "message",
    "agent_run",
    "sequence_run",
    "job",
    "group_status_changed",
    "group_settings_changed",
    "member_changed",
  ])
  .meta({ id: "ActivityEventType" });
export type ActivityEventType = z.infer<typeof ActivityEventType>;

/** 与 WS 事件帧同形；payload 原样（形状见 src/services/ws-events.ts 各 type 的注释） */
export const ActivityItem = z
  .object({
    seq: z.number().int(),
    type: ActivityEventType,
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "ActivityItem" });
export type ActivityItem = z.infer<typeof ActivityItem>;

/** `?before=&limit=`：before 是上一页的 nextCursor（不透明），limit 默认 50、上限 200；按 seq 倒序 */
export const ActivityListQuery = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ActivityListQuery = z.infer<typeof ActivityListQuery>;

/** 游标分页 `{ items, nextCursor }`。命名为 *Page 而不是 *ListResponse：后者的审计要求 items + total（同 MessagePage） */
export const ActivityPage = z
  .object({
    items: z.array(ActivityItem),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "ActivityPage" });
export type ActivityPage = z.infer<typeof ActivityPage>;
