// 消息（题目 2.3 `GET /api/groups/:id/messages`）的 zod schema。出站 outbox（#7）与时间线（#9）共用：
// messages 表一表两用（入站 message 事件与出站 outbox 都是一行），Read 模型也只有一个。
// Read 模型可派生：deliveryStatus 用具名 enum（.meta({ id }) 进 openapi components），取值从生成的
// Prisma enum 派生，不抄第二份；时间字段 ISO 8601 UTC 字符串；字段不带 default；可空字段恒下发 null。
import { z } from "zod";

import { DeliveryStatus as PrismaDeliveryStatus } from "../db/generated/enums.js";

/** 出站投递状态机 `queued → accepted → sent | failed | unknown | cancelled`；入站行为 null。 */
export const DeliveryStatus = z
  .enum(Object.values(PrismaDeliveryStatus))
  .meta({ id: "DeliveryStatus" });
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/**
 * 题目 2.3：`{ msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode }`。
 * - msgId：网关的消息 id；自己发的消息在 message_sent 之前为 null（从 queued 起就在列表里）。
 * - clientMsgId：出站幂等键；入站行为 null。
 * - deliveryStatus / failCode：仅出站行有值。
 * - sentAt：时间线排序键；出站行先是受理时刻，发出后改为网关的 sentAt。
 * - mediaUrl / localFilePath（题目 C1）：网关给的附件地址；下载到本地后的路径（没下载 / 下载放弃 / 已过保留期被清理为 null）。
 */
export const MessageRead = z
  .object({
    msgId: z.string().nullable(),
    clientMsgId: z.string().nullable(),
    senderPlatformUserId: z.string(),
    isOwn: z.boolean(),
    text: z.string(),
    sentAt: z.iso.datetime(),
    deliveryStatus: DeliveryStatus.nullable(),
    failCode: z.string().nullable(),
    mediaUrl: z.string().nullable(),
    localFilePath: z.string().nullable(),
  })
  .meta({ id: "MessageRead" });
export type MessageRead = z.infer<typeof MessageRead>;

export const GroupIdParams = z.object({
  id: z.string().min(1),
});

/** 题目 2.3：`?before=&limit=50`。before 是上一页返回的 nextCursor（不透明字符串），limit 上限 200。 */
export const MessageListQuery = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessageListQuery = z.infer<typeof MessageListQuery>;

/**
 * 时间线的游标分页形状 `{ items, nextCursor }`（api-conventions 三种列表形状之二）：总数在一直增长的
 * 消息流上没有意义，所以没有 total。命名为 MessagePage 而不是 MessageListResponse：openapi 导出的审计
 * 对 `*ListResponse` 要求 items + total，那条规则是给分页 / 短列表形状用的，游标形状不该匹配它。
 * nextCursor 为 null 表示没有更早的消息了。
 */
export const MessagePage = z
  .object({
    items: z.array(MessageRead),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "MessagePage" });
export type MessagePage = z.infer<typeof MessagePage>;

// ---- 发消息（题目 2.3 `POST /api/groups/:id/send`，issue #7）----------------------------------

/** 题目 2.3：`{ accountId, text }`。形状错由 setErrorHandler 出 400 VALIDATION_ERROR。 */
export const SendRequest = z.object({
  accountId: z.string().min(1),
  text: z.string().min(1),
});
export type SendRequest = z.infer<typeof SendRequest>;

/** 202：出站记录已落库（queued），clientMsgId 是它的幂等键，时间线里按它看 deliveryStatus。 */
export const SendResponse = z
  .object({
    clientMsgId: z.string(),
  })
  .meta({ id: "SendResponse" });
export type SendResponse = z.infer<typeof SendResponse>;
