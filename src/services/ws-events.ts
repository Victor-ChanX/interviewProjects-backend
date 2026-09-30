// ws_events：推给前端的事件源（issue #9）。表是唯一的真相：业务写在**同一个事务**里落一行（事务回滚事件就一起
// 没了，不会推出一个没保存的状态），src/services/ws-hub.ts 轮询它广播给 WebSocket 客户端，断线重连按 sinceSeq
// 从表里补发（#18）。多副本安全：没有进程内队列，谁写的行大家都能推。
//
// 推送序号 seq 不在写入时分配：自增值在 INSERT 时拿、提交顺序却可能不同 —— 先拿到 10 的事务晚于拿到 11 的提交时，
// 读者早已把水位推过 10，10 就永远不推、重连也不补。所以写入时 seq 为空，排号器 assignWsSeqs 只给**已提交**的行
// 按写入顺序（id）接着 max(seq) 连续编号；读者只读已排号的行。晚提交的小 id 拿到的是更大的 seq，水位不会越过它。
//
// 其他模块用 emitWsEvent(tx, type, payload) 写，不直接 tx.wsEvent.create：type 集中在这里成为契约
// （前端按 type 分支），payload 形状见各写入方的注释。
import type { Db } from "../db/client.js";
import type { Prisma, WsEvent } from "../db/generated/client.js";

/** 排号器的 advisory lock 键（本项目内唯一，ASCII "WSEQ"）：多副本同时排号时串行 */
const WS_SEQ_LOCK_KEY = 0x57534551;
/** 一次最多排号的行数；排不完的下一次接着排 */
export const WS_SEQ_BATCH = 1_000;

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
  /**
   * 群成员变化 { groupId, platformUserId, accountId | null, change }：
   * change = joined | left（入站 worker #8）| promoted（建群 job #11 把 memberAccountIds[0] 提成 admin）
   */
  "member_changed",
  /** 群状态变化 { groupId, from, to, reason }（#7：GROUP_WRITE_FORBIDDEN → unreachable） */
  "group_status_changed",
  /** 群开关变化 { groupId, agentEnabled, autoKickEnabled }（#11：PATCH /api/groups/:id） */
  "group_settings_changed",
  /** 建群 / leave-all job 状态 { jobId, groupId, kind, status, step }（#11：每步推进与终态） */
  "job",
  /**
   * 不一致记录被标记为已处理 { id, resolvedAt, resolvedBy }（#22：POST /api/inconsistencies/:id/resolve；
   * 只在「未处理 → 已处理」那一次推，重复 resolve 不推）。操作回执，不进 GET /api/activity 的动态流。
   */
  "inconsistency_resolved",
] as const;
export type WsEventType = (typeof WS_EVENT_TYPES)[number];

/**
 * 在事务里写一行 ws_events。传业务事务的 tx（`$transaction(async (tx) => …)`），事件与业务写一起提交 / 回滚；
 * 事务外的旁路事件也可以传 getDb()。返回写入的行（seq 为空，提交后由 assignWsSeqs 排号）。
 */
export async function emitWsEvent(
  tx: Prisma.TransactionClient | Db,
  type: WsEventType,
  payload: Prisma.InputJsonObject,
): Promise<WsEvent> {
  return tx.wsEvent.create({ data: { type, payload } });
}

/**
 * 排号：给已提交、还没排号的行按 id 顺序从 max(seq) + 1 起连续编 seq，返回排了几条。
 * 事务里先拿 advisory xact lock：多副本串行，一次排号整体提交之后下一次才开始（READ COMMITTED 下拿到锁之后的
 * 语句看得见上一次的提交），所以 seq 可见的顺序就是编号的顺序，没有空洞 —— 读者按「seq > 水位」读不会跳号。
 * ws-hub 每次轮询先调它；测试里写完事件想马上按 seq 读，也先调它。
 */
export async function assignWsSeqs(
  db: Db,
  limit: number = WS_SEQ_BATCH,
): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WS_SEQ_LOCK_KEY}::bigint)`;
    return tx.$executeRaw`
      WITH base AS (SELECT COALESCE(MAX(seq), 0) AS n FROM ws_events),
      pending AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
        FROM ws_events WHERE seq IS NULL
        ORDER BY id
        LIMIT ${limit}
      )
      UPDATE ws_events w SET seq = base.n + pending.rn
      FROM base, pending
      WHERE w.id = pending.id`;
  });
}
