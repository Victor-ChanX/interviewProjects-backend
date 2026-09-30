// 最近动态（#22：GET /api/activity）：ws_events 的只读视图，控制台「实时动态」首屏用它，之后靠 WS 追加
// （帧同形 { seq, type, payload }，前端按 seq 去重、拼接）。
//
// - 按 seq 倒序（seq 是推送顺序，与 WS 帧同一个号；createdAt 可能同毫秒）；keyset 游标 = seq，`WHERE seq < 游标`。
//   只列已排号的行（src/services/ws-events.ts 的 assignWsSeqs）：翻页途中新排号的事件 seq 更大，只会出现在第一页之前，
//   不挤动后面的页 —— 不重不漏。
// - 只下发白名单类型（src/schemas/activity.ts 的 ActivityEventType）：操作回执类（inconsistency_resolved）不进动态流。
//   白名单是 WS_EVENT_TYPES 的子集，下面的类型标注让两边对不上时 tsc 红。
// - payload 原样下发（形状见 src/services/ws-events.ts 各 type 的注释）。
//
// 数据范围：只有 admin / viewer 两种角色，登录用户都看全平台动态（与 WS 推送同口径）。
import { getDb } from "../db/client.js";
import {
  ActivityEventType,
  type ActivityItem,
  type ActivityPage,
} from "../schemas/activity.js";
import {
  clampLimit,
  decodeSeqCursor,
  encodeSeqCursor,
  sliceCursorPage,
} from "./cursor.js";
import type { WsEventType } from "./ws-events.js";

export type ListActivityOptions = {
  before?: string;
  limit?: number;
};

function isActivityType(type: string): type is ActivityEventType {
  return (ActivityEventType.options as readonly string[]).includes(type);
}

export async function listActivity(
  opts: ListActivityOptions = {},
): Promise<ActivityPage> {
  const limit = clampLimit(opts.limit);
  const beforeSeq =
    opts.before === undefined ? null : decodeSeqCursor(opts.before);
  // 白名单必须是 WS 事件类型的子集（这行赋值在 tsc 层面保证）
  const types: readonly WsEventType[] = ActivityEventType.options;
  const rows = await getDb().wsEvent.findMany({
    where: {
      type: { in: [...types] },
      seq: beforeSeq !== null ? { lt: beforeSeq } : { not: null },
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
  });
  // where 已排除未排号的行；这里只是把 seq 的类型收窄成 number
  const published = rows.flatMap((row) =>
    row.seq === null ? [] : [{ ...row, seq: row.seq }],
  );
  const { page, nextCursor } = sliceCursorPage(published, limit, (last) =>
    encodeSeqCursor(last.seq),
  );
  const items: ActivityItem[] = [];
  for (const row of page) {
    if (!isActivityType(row.type)) continue;
    const payload =
      typeof row.payload === "object" &&
      row.payload !== null &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : { value: row.payload };
    items.push({
      seq: row.seq,
      type: row.type,
      payload,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return { items, nextCursor };
}
