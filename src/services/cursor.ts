// keyset 游标的编码 / 解码（api-conventions「游标怎么编码」）：时间线 / 流式列表共用，别在各 service 里各写一份。
//
// 游标对前端不透明：base64url(`<ISO 毫秒>|<id>`) 或 base64url(`seq:<n>`)。解不开 / 形状不对 → 422
// VALIDATION_ERROR：游标是我们发下去的，客户端改请求（用上一页响应里的 nextCursor）就能修好。
//
// 精度约定：排序时间列的写入方都用 JS Date（毫秒；Prisma 的 @default(now()) 也由客户端按毫秒填），
// 游标编码 ISO 毫秒与列值相等；若有微秒精度的行，`(t = 游标 AND id < …)` 的等值比较会失配而漏行 ——
// 所以不要用数据库的 now() 写这些列。
import { Invalid } from "../core/errors.js";

/** 列表 limit 的默认与上限（各游标列表同口径；schema 用 .max() 钳，service 直接调用时自己再钳一次） */
export const CURSOR_PAGE_DEFAULT_LIMIT = 50;
export const CURSOR_PAGE_MAX_LIMIT = 200;

export type TimeCursor = { at: Date; id: string };

function invalidCursor(): Invalid {
  return new Invalid(
    "VALIDATION_ERROR",
    "before 游标无效，请使用上一页响应里的 nextCursor",
  );
}

/** 把调用方给的 limit 钳进 [1, CURSOR_PAGE_MAX_LIMIT]，没给用默认值 */
export function clampLimit(
  limit: number | undefined,
  fallback: number = CURSOR_PAGE_DEFAULT_LIMIT,
): number {
  return Math.min(
    Math.max(1, Math.trunc(limit ?? fallback)),
    CURSOR_PAGE_MAX_LIMIT,
  );
}

export function encodeTimeCursor(c: TimeCursor): string {
  return Buffer.from(`${c.at.toISOString()}|${c.id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeTimeCursor(raw: string): TimeCursor {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const sep = text.indexOf("|");
  if (sep <= 0 || sep === text.length - 1) throw invalidCursor();
  const at = new Date(text.slice(0, sep));
  if (Number.isNaN(at.getTime())) throw invalidCursor();
  return { at, id: text.slice(sep + 1) };
}

export function encodeSeqCursor(seq: number): string {
  return Buffer.from(`seq:${seq}`, "utf8").toString("base64url");
}

export function decodeSeqCursor(raw: string): number {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const m = /^seq:(\d{1,15})$/.exec(text);
  if (!m?.[1]) throw invalidCursor();
  return Number(m[1]);
}

/**
 * 「多取一条」的收尾：rows 是按 limit + 1 取回来的，有第 limit+1 条说明还有下一页，nextCursor 指向本页最后一条。
 */
export function sliceCursorPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => string,
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
  };
}
