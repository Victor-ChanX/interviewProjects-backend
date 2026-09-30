// ws_events：推给前端的事件源（issue #9）。表是唯一的真相：seq 自增、全局单调，业务写在**同一个事务**里
// 落一行（事务回滚事件就一起没了，不会推出一个没保存的状态），src/services/ws-hub.ts 轮询它广播给 WebSocket
// 客户端，断线重连按 sinceSeq 从表里补发（#18）。多副本安全：没有进程内队列，谁写的行大家都能推。
//
// 其他模块用 emitWsEvent(tx, type, payload) 写，不直接 tx.wsEvent.create：type 集中在这里成为契约
// （前端按 type 分支），payload 形状见各写入方的注释。
import type { Db } from "../db/client.js";
import type { Prisma, WsEvent } from "../db/generated/client.js";

/** 事件 type（题目 2.3 WS 帧的 type 列表 + 群成员变化） */
export const WS_EVENT_TYPES = [
  /** 账号状态转移 { accountId, from, to }（src/services/account-service.ts） */
  "account_status_changed",
  /** 账号进终态 { accountId, status } */
  "account_terminal",
  /** 不一致记录 { inconsistencyId, ... }（A2） */
  "inconsistency",
  /** 消息新增 / 投递状态变化 { groupId, msgId, clientMsgId, deliveryStatus, ... }（#7 / #8） */
  "message",
  /** Agent 运行状态 { runId, groupId, status, ... } */
  "agent_run",
  /** 序列运行状态 { runId, groupId, status, ... } */
  "sequence_run",
  /** 群成员变化 { groupId, accountId, change } */
  "member_changed",
  /** 群状态变化 { groupId, from, to, reason }（#7：GROUP_WRITE_FORBIDDEN → unreachable） */
  "group_status_changed",
] as const;
export type WsEventType = (typeof WS_EVENT_TYPES)[number];

/**
 * 在事务里写一行 ws_events。传业务事务的 tx（`$transaction(async (tx) => …)`），事件与业务写一起提交 / 回滚；
 * 事务外的旁路事件也可以传 getDb()。返回写入的行（含 seq）。
 */
export async function emitWsEvent(
  tx: Prisma.TransactionClient | Db,
  type: WsEventType,
  payload: Prisma.InputJsonObject,
): Promise<WsEvent> {
  return tx.wsEvent.create({ data: { type, payload } });
}
