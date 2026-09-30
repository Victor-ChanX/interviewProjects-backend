// 群消息时间线（题目 2.3 `GET /api/groups/:id/messages`，issue #9）。
//
// keyset 游标分页，不用 offset：排序键 (sentAt desc, id desc)，游标 = base64(`<sentAt ISO>|<id>`)，对前端不透明。
// `before` 解析后查 `(sent_at, id) < (cursorAt, cursorId)`（写成等价的 OR：sent_at < a OR (sent_at = a AND id < b)，
// 走 messages 表的 (group_id, sent_at desc, id desc) 索引），多取一条判有没有下一页。
// 为什么 keyset 在「翻页途中有新消息写入」时不重不漏：新消息的 sentAt 比游标新，永远落在游标之前的页里，
// 不会挤动游标之后的行；offset 在这时会让下一页重复一条。
// 自己发的消息从 queued 起就在列表里（#7 写的行 isOwn = true、sentAt = 受理时刻，发出后改为网关的 sentAt）：
// 一条消息只有一行，列表不做任何状态过滤。
//
// 精度约定：sentAt 的写入方都用 JS Date（毫秒），游标编码 ISO 字符串（毫秒）与列值相等；若有微秒精度的行，
// 游标等值比较会失配 —— 所以不要用数据库的 now() 写 sentAt。
//
// 数据范围：本项目只有 admin / viewer 两种角色，登录用户都可看全部群的消息，没有归属键；
// 群不存在 → 404 GROUP_NOT_FOUND。
import { Invalid, NotFound } from "../core/errors.js";
import { getDb } from "../db/client.js";
import type { Message, Prisma } from "../db/generated/client.js";
import type { MessagePage, MessageRead } from "../schemas/message.js";

/** limit 的默认与上限（与 src/schemas/message.ts 的 MessageListQuery 同口径；service 自己也钳一次，直接调用不经 zod） */
export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const MESSAGE_PAGE_MAX_LIMIT = 200;

export type ListMessagesOptions = {
  /** 上一页的 nextCursor；不给 = 从最新一条开始 */
  before?: string;
  limit?: number;
};

type Cursor = { sentAt: Date; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.sentAt.toISOString()}|${c.id}`, "utf8").toString(
    "base64url",
  );
}

/** 解不开 / 形状不对 → 422：游标是我们发下去的，客户端改请求（用上一页的 nextCursor）就能修好。 */
function decodeCursor(raw: string): Cursor {
  const invalid = (): Invalid =>
    new Invalid(
      "VALIDATION_ERROR",
      "before 游标无效，请使用上一页响应里的 nextCursor",
    );
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalid();
  }
  const sep = text.indexOf("|");
  if (sep <= 0 || sep === text.length - 1) throw invalid();
  const sentAt = new Date(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (Number.isNaN(sentAt.getTime())) throw invalid();
  return { sentAt, id };
}

export function toMessageRead(row: Message): MessageRead {
  return {
    msgId: row.msgId,
    clientMsgId: row.clientMsgId,
    senderPlatformUserId: row.senderPlatformUserId,
    isOwn: row.isOwn,
    text: row.text,
    sentAt: row.sentAt.toISOString(),
    deliveryStatus: row.deliveryStatus,
    failCode: row.failCode,
  };
}

export async function listMessages(
  groupId: string,
  opts: ListMessagesOptions = {},
): Promise<MessagePage> {
  const db = getDb();
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? MESSAGE_PAGE_DEFAULT_LIMIT)),
    MESSAGE_PAGE_MAX_LIMIT,
  );
  const cursor = opts.before === undefined ? null : decodeCursor(opts.before);

  const group = await db.group.findUnique({
    where: { id: groupId },
    select: { id: true },
  });
  if (!group) {
    throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除");
  }

  const where: Prisma.MessageWhereInput = {
    groupId,
    ...(cursor
      ? {
          OR: [
            { sentAt: { lt: cursor.sentAt } },
            { sentAt: cursor.sentAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  // 多取一条：有第 limit+1 条说明还有更早的，nextCursor 指向本页最后一条
  const rows = await db.message.findMany({
    where,
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(toMessageRead),
    nextCursor:
      hasMore && last
        ? encodeCursor({ sentAt: last.sentAt, id: last.id })
        : null,
  };
}
