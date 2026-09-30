// WebSocket 推送 hub（issue #9 / #18）：把 ws_events 表的新行推给本进程的已认证连接。
//
// 事件源是表，不是进程内队列：业务在自己的事务里写行（src/services/ws-events.ts），hub 每次轮询先排号
// （assignWsSeqs：提交之后才给 seq，连续、按可见顺序单调），再做「seq > 水位」的读取 + 广播。多副本各自轮询同一张表，谁写的行大家都推；进程重启，水位从 max(seq)
// 重新开始，断线期间的事件由客户端带 sinceSeq 重连补发 —— 所以这里的连接集合虽然在内存里，但它不是「跨请求状态」
// （连接本来就只属于这个进程），真相全在库里。
//
// 每个连接记 lastSentSeq：只推 seq 大于它的行，广播一条推一次，重连补发（sinceSeq）与实时推送共用这一个水位，
// 天然不重复；轮询的起点取 hub 水位与所有实时连接水位的最小值，刚补发完的连接落后一点也能被下一次轮询追上，
// 不会漏。补发上限 maxReplay：sinceSeq 落后超过它的连接从 max(seq) − maxReplay 开始，并先推一帧
// `{ type: "resync", sinceSeq, fromSeq }` 告诉客户端中间有缺口、要走 REST 重新拉一次全量。
//
// 轮询的定时器不在这里（service 不起定时器）：src/workers/ws-broadcast-worker.ts 每 pollIntervalMs 调一次 pump()。
// 认证超时同理按注入时钟算：attach 时记 connectedAt，pump 里把超过 authTimeoutMs 仍未认证的连接关掉。
// 认证不是一次性的（题目 B3：logout 后同一 access token 立即失效）：认证时记下会话 id 与 token 到期时刻，pump 里
// token 一到期就关；每 sessionRecheckMs 按会话 id 批量查一次库，作废的（logout / refresh 复用）也关。都用 4401 ——
// 客户端据此走 refresh，拿新 token 带 sinceSeq 重连，期间的事件照常补发。
//
// 帧（服务端 → 客户端）：
//   { type: "auth", success: true }                        认证通过（authenticate 里发，保证在任何事件帧之前）
//   { type: "resync", sinceSeq, fromSeq }                  补发有缺口：(sinceSeq, fromSeq] 之间的事件不再补
//   { seq, type, payload }                                 事件帧，type 见 src/services/ws-events.ts
import { type Clock, systemClock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import { inactiveSessionIds } from "./auth-service.js";
import { assignWsSeqs } from "./ws-events.js";

/** hub 对连接的最小要求（@fastify/websocket 给的 ws.WebSocket 满足它；service 不 import ws / fastify） */
export type WsSink = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WsConnection = {
  readonly socket: WsSink;
  readonly connectedAt: Date;
  /** authenticate 之后为 true；之前不推任何事件 */
  authenticated: boolean;
  /** 已推到的 seq：只推大于它的行。未认证时无意义 */
  lastSentSeq: number;
  /** 认证用的会话 id 与 access token 到期时刻；未认证时为 null */
  session: { id: string; expiresAt: Date } | null;
};

export type WsHubDeps = {
  clock?: Clock;
  log?: Logger;
  /** 连接建立后多久没认证就关掉（题目：5 秒） */
  authTimeoutMs?: number;
  /** sinceSeq 补发的上限条数；落后更多的连接从 max(seq) − maxReplay 起并推 resync */
  maxReplay?: number;
  /** 一次 pump 最多取多少行（落后的连接分几次追上） */
  batchSize?: number;
  /** 多久按会话 id 复核一次已认证连接（logout / 作废后多久断开） */
  sessionRecheckMs?: number;
};

export type PumpResult = {
  /** 本次推出的事件帧数（按连接计） */
  delivered: number;
  /** 本次因认证超时关掉的连接数 */
  authTimedOut: number;
  /** 本次因 token 到期或会话作废关掉的连接数 */
  sessionEnded: number;
};

export type WsHub = {
  /** 连接建立：登记为待认证。返回的连接对象给 authenticate / detach 用 */
  attach(socket: WsSink): WsConnection;
  /**
   * 认证通过：回 auth 成功帧、按 sinceSeq 定水位（落后超过 maxReplay 先推 resync），进入实时。
   * 返回 resync 信息（没有缺口为 null）。
   */
  authenticate(
    conn: WsConnection,
    opts: {
      sinceSeq?: number;
      session: { id: string; expiresAt: Date };
    },
  ): Promise<{ resync: { sinceSeq: number; fromSeq: number } | null }>;
  /** 连接关闭 / 出错：从集合移除（幂等） */
  detach(conn: WsConnection): void;
  /** 一次轮询：关认证超时的连接，把 seq > 水位的新行推给所有实时连接 */
  pump(): Promise<PumpResult>;
  /** 关掉所有连接（优雅停机；worker 的循环由 worker 自己停） */
  stop(): Promise<void>;
  /** 当前连接数（含未认证） */
  readonly size: number;
};

export const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_REPLAY = 1_000;
export const DEFAULT_BATCH_SIZE = 500;
export const DEFAULT_SESSION_RECHECK_MS = 2_000;

/** 客户端要求服务端关闭时用的应用级 close code（4000–4999 归应用定义） */
export const WS_CLOSE_AUTH_TIMEOUT = 4401;
/** token 到期 / 会话作废：同一个 4401，客户端统一走 refresh 后重连 */
export const WS_CLOSE_SESSION_ENDED = 4401;
export const WS_CLOSE_SHUTDOWN = 1001;

async function maxSeq(): Promise<number> {
  const agg = await getDb().wsEvent.aggregate({ _max: { seq: true } });
  return agg._max.seq ?? 0;
}

export function createWsHub(deps: WsHubDeps = {}): WsHub {
  const clock = deps.clock ?? systemClock;
  const log = (deps.log ?? logger).child({ component: "ws-hub" });
  const authTimeoutMs = deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const maxReplay = deps.maxReplay ?? DEFAULT_MAX_REPLAY;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const sessionRecheckMs = deps.sessionRecheckMs ?? DEFAULT_SESSION_RECHECK_MS;
  /** 上一次按会话 id 复核的时刻（注入时钟）；null = 还没复核过 */
  let lastSessionCheck: number | null = null;

  const conns = new Set<WsConnection>();
  /** hub 自己的水位：没有连接时也推进，避免第一个连接进来时把历史全推一遍。null = 还没初始化 */
  let watermark: number | null = null;

  const ensureWatermark = async (): Promise<number> => {
    if (watermark === null) watermark = await maxSeq();
    return watermark;
  };

  const detach = (conn: WsConnection): void => {
    conns.delete(conn);
  };

  const safeSend = (conn: WsConnection, data: string): boolean => {
    try {
      conn.socket.send(data);
      return true;
    } catch (err) {
      log.warn({ err }, "推送失败，移除连接");
      detach(conn);
      return false;
    }
  };

  const safeClose = (
    conn: WsConnection,
    code: number,
    reason: string,
  ): void => {
    detach(conn);
    try {
      conn.socket.close(code, reason);
    } catch (err) {
      log.warn({ err, code }, "关闭连接失败");
    }
  };

  return {
    get size() {
      return conns.size;
    },

    attach(socket) {
      const conn: WsConnection = {
        socket,
        connectedAt: clock.now(),
        authenticated: false,
        lastSentSeq: 0,
        session: null,
      };
      conns.add(conn);
      return conn;
    },

    async authenticate(conn, opts) {
      // 认证时刻的 max(seq)：没带 sinceSeq 的连接从「现在」起推，之前的事件不推（客户端先走 REST 拉现状）。
      // hub 水位也对齐到它：表是真相，表里的 max 比内存水位小只可能是表被清过（测试的 truncate），跟着表走。
      const max = await maxSeq();
      watermark = max;
      if (!conns.has(conn)) {
        // 认证查库期间连接已经关了
        return { resync: null };
      }

      let resync: { sinceSeq: number; fromSeq: number } | null = null;
      if (opts.sinceSeq === undefined) {
        conn.lastSentSeq = max;
      } else if (max - opts.sinceSeq > maxReplay) {
        const fromSeq = max - maxReplay;
        resync = { sinceSeq: opts.sinceSeq, fromSeq };
        conn.lastSentSeq = fromSeq;
      } else {
        // 客户端报的 sinceSeq 比库里还大（换库 / 造假）就当作「从现在起」
        conn.lastSentSeq = Math.min(opts.sinceSeq, max);
      }

      // 以下同步执行：auth 成功帧一定先于任何事件帧（pump 只在 await 之后的同步段里广播，插不进来）
      if (!safeSend(conn, JSON.stringify({ type: "auth", success: true }))) {
        return { resync: null };
      }
      if (resync) {
        safeSend(conn, JSON.stringify({ type: "resync", ...resync }));
      }
      conn.session = opts.session;
      conn.authenticated = true;
      return { resync };
    },

    detach,

    async pump() {
      await assignWsSeqs(getDb());
      const base = await ensureWatermark();
      const result: PumpResult = {
        delivered: 0,
        authTimedOut: 0,
        sessionEnded: 0,
      };

      // 认证超时：按注入时钟算，不起定时器
      const now = clock.now().getTime();
      for (const conn of [...conns]) {
        if (
          !conn.authenticated &&
          now - conn.connectedAt.getTime() >= authTimeoutMs
        ) {
          safeClose(conn, WS_CLOSE_AUTH_TIMEOUT, "auth timeout");
          result.authTimedOut += 1;
        }
      }

      // 已认证的连接：token 到期立刻关；会话作废按间隔批量复核
      const endSession = (conn: WsConnection, reason: string): void => {
        safeClose(conn, WS_CLOSE_SESSION_ENDED, reason);
        result.sessionEnded += 1;
      };
      for (const conn of [...conns]) {
        if (conn.session && now >= conn.session.expiresAt.getTime()) {
          endSession(conn, "token expired");
        }
      }
      if (
        lastSessionCheck === null ||
        now - lastSessionCheck >= sessionRecheckMs
      ) {
        lastSessionCheck = now;
        const withSession = [...conns].filter((c) => c.session !== null);
        const ids = [...new Set(withSession.map((c) => c.session?.id ?? ""))];
        const inactive = await inactiveSessionIds(ids);
        for (const conn of withSession) {
          if (conns.has(conn) && inactive.has(conn.session?.id ?? "")) {
            endSession(conn, "session revoked");
          }
        }
      }

      const live = [...conns].filter((c) => c.authenticated);
      // 起点 = hub 水位与所有实时连接水位的最小值：补发中的连接也从这一次轮询里追
      let floor = base;
      for (const conn of live) {
        if (conn.lastSentSeq < floor) floor = conn.lastSentSeq;
      }

      const rows = await getDb().wsEvent.findMany({
        where: { seq: { gt: floor } },
        orderBy: { seq: "asc" },
        take: batchSize,
      });
      if (rows.length === 0) return result;

      const frames = rows.flatMap((row) =>
        row.seq === null
          ? []
          : [
              {
                seq: row.seq,
                data: JSON.stringify({
                  seq: row.seq,
                  type: row.type,
                  payload: row.payload,
                }),
              },
            ],
      );
      for (const conn of live) {
        if (!conns.has(conn)) continue;
        for (const frame of frames) {
          if (frame.seq <= conn.lastSentSeq) continue;
          if (!safeSend(conn, frame.data)) break;
          conn.lastSentSeq = frame.seq;
          result.delivered += 1;
        }
      }

      const lastSeq = frames[frames.length - 1]?.seq ?? base;
      if (lastSeq > (watermark ?? 0)) watermark = lastSeq;
      return result;
    },

    async stop() {
      for (const conn of [...conns]) {
        safeClose(conn, WS_CLOSE_SHUTDOWN, "server shutting down");
      }
      conns.clear();
    },
  };
}
