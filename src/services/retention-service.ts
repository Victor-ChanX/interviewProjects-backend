// 事件类表的保留期清理（后端 #57）。这几张表只增不减，不清就无限增长：
// - ws_events：推送与「最近动态」的来源。保留 WS_EVENT_RETENTION_MS；**seq 最大的那一行永远留着** —— 排号器按
//   MAX(seq) + 1 给新事件编号（ws-events.assignWsSeqs），全删了序号会从 1 重来，客户端带着大 sinceSeq 就再也收不到推送。
//   断线超过保留期的客户端补发不全，前端重连时本来就会整页重拉。
// - inbound_events：入站去重与重试的账本。只删已处理的、收到时间早于 INBOUND_RETENTION_MS 的 —— 游标早已越过它们，
//   网关不会再按原 eventId 推回来（补投用新 eventId）。
// - outbound_attempts：出站投递的审计记录，结束早于 OUTBOUND_ATTEMPT_RETENTION_MS 的删。
// - login_throttles：窗口已过、没锁着的节流行（auth-service 的登录节流）。
// 每张表一次最多删 RETENTION_BATCH 行（大表不在一条语句里锁太久），没删完下一轮接着删。手写 SQL 用数据库列名。
import { getDb } from "../db/client.js";
import { LOGIN_WINDOW_MS } from "./auth-service.js";

const DAY_MS = 86_400_000;
export const WS_EVENT_RETENTION_MS = 7 * DAY_MS;
export const INBOUND_RETENTION_MS = 30 * DAY_MS;
export const OUTBOUND_ATTEMPT_RETENTION_MS = 30 * DAY_MS;
export const RETENTION_BATCH = 5_000;

export type RetentionResult = {
  wsEvents: number;
  inboundEvents: number;
  outboundAttempts: number;
  loginThrottles: number;
};

export async function purgeOldEvents(
  now: Date,
  batch: number = RETENTION_BATCH,
): Promise<RetentionResult> {
  const db = getDb();
  const wsCutoff = new Date(now.getTime() - WS_EVENT_RETENTION_MS);
  const inboundCutoff = new Date(now.getTime() - INBOUND_RETENTION_MS);
  const attemptCutoff = new Date(now.getTime() - OUTBOUND_ATTEMPT_RETENTION_MS);
  const throttleCutoff = new Date(now.getTime() - LOGIN_WINDOW_MS);

  const wsEvents = await db.$executeRaw`
    DELETE FROM ws_events WHERE id IN (
      SELECT id FROM ws_events
      WHERE seq IS NOT NULL AND created_at < ${wsCutoff}
        AND seq < (SELECT MAX(seq) FROM ws_events)
      ORDER BY id
      LIMIT ${batch}
    )`;
  const inboundEvents = await db.$executeRaw`
    DELETE FROM inbound_events WHERE id IN (
      SELECT id FROM inbound_events
      WHERE processed_at IS NOT NULL AND received_at < ${inboundCutoff}
      LIMIT ${batch}
    )`;
  const outboundAttempts = await db.$executeRaw`
    DELETE FROM outbound_attempts WHERE id IN (
      SELECT id FROM outbound_attempts
      WHERE finished_at IS NOT NULL AND finished_at < ${attemptCutoff}
      LIMIT ${batch}
    )`;
  const loginThrottles = await db.$executeRaw`
    DELETE FROM login_throttles
    WHERE window_started_at < ${throttleCutoff}
      AND (locked_until IS NULL OR locked_until < ${now})`;
  return { wsEvents, inboundEvents, outboundAttempts, loginThrottles };
}
