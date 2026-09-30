// 入站 SSE worker（issue #8）：读游标 → 带 since 连网关事件流 → 逐条 ingest → 推进游标 → 断了就退避重连。
//
// - 位置在库里（event_cursor.lastEventId），不在内存：重启 / 断线都从游标之后补拉（题目 A2：停机或断流期间
//   的事件恢复后都要处理到）。游标从未写过（首次启动）时带 since=0 从头回放：题目 2.1 的网关保留全部历史事件，
//   不带 since（= 从当前时刻开始）的话，首次启动前、以及收到第一条之前断流的那段事件都会丢（后端 #54）。
// - **游标只推到「比它小的事件都已处理」的位置**：相邻事件可能乱序（窗口 ≤ 1s），先到的可能是更大的 id。收到 101
//   就把游标推到 101，而 100 还在路上时断流 / 崩溃，重连带 since=101，100 就永远收不到了。所以游标只沿**连号**前进：
//   游标是 c 时收到 c + 1 —— 两个整数之间没有别的 id，前进（接着看已收到的 c + 2 …）。遇到空洞不按时间越过：
//   「收到之后过了多久」量不出比它小的事件到没到 —— 处理慢的时候，晚到的小 id 可能还躺在 socket 缓冲里没读。
//   但题目只保证 eventId 单调递增、不保证连续：网关的 id 本身有空洞时，游标会永远停在空洞前、每次重连都重放后面的
//   全部历史。所以空洞「又等了 GAP_SKIP_FRAMES 帧、且过了 GAP_SKIP_MS」仍没补上才越过（两个条件都满足：远超 1 秒的
//   乱序窗口，也不会因为一次慢处理就误越过），越过时记一行告警（后端 #54）。
// - 空闲超时：一条流 SSE_IDLE_TIMEOUT_MS 内一帧都没有就主动断开重连（按游标补拉，去重吃掉重复）—— TCP 半开时
//   读永远不返回，不设超时入站就一直卡着。
// - 一条一条处理：ingest 自己吞掉「处理失败」（入册 + 不一致记录 + 排重试，重试见 inbound-retry-worker），
//   只在库不可用时抛；那时断开这条流、退避后从游标重连，事件不会丢（游标没推进）。
// - 退避有界：min(base × 2^n, cap) + 抖动；一条流只要收到过帧就把 n 清零。
// - stop()：abort 掐断 fetch → 流安静结束 → 等在途的 ingest 完成 → 返回。SIGTERM 路径见 src/main.ts。
// - setTimeout 只用于退避等待（「多久再试」），排期本身没有 —— 事件流是推送，不是轮询。
import { randomInt } from "node:crypto";

import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import type { GatewayClient } from "../services/gateway-client.js";
import {
  advanceCursor,
  type ApplyGatewayDelivery,
  ingest,
  readCursor,
} from "../services/inbound-service.js";

/** 一条流这么久一帧都没收到就断开重连 */
export const SSE_IDLE_TIMEOUT_MS = 60_000;

/** 游标遇到空洞：之后又处理了这么多帧、且过了这么久仍没补上，就越过它（见文件头） */
export const GAP_SKIP_FRAMES = 200;
export const GAP_SKIP_MS = 10_000;

/** 退避常量（毫秒）：首次 1s，翻倍到 30s 封顶，再加 0–500ms 抖动 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;
const RECONNECT_JITTER_MS = 500;

export type InboundWorkerDeps = {
  clock: Clock;
  gateway: Pick<GatewayClient, "openEventStream">;
  /** #7 的 outbox-service.applyGatewayDelivery；没给时 message_sent / message_failed 按处理失败入册 */
  applyGatewayDelivery?: ApplyGatewayDelivery;
  /** 退避等待；测试注入立即返回的实现。signal abort 时应立刻 resolve */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 一条流空闲多久断开重连；默认 SSE_IDLE_TIMEOUT_MS */
  idleTimeoutMs?: number;
  /** 读 / 写游标；默认走 inbound-service（库）。测试可替换 */
  cursorStore?: {
    read(): Promise<number | null>;
    advance(eventId: number): Promise<void>;
  };
  log?: Logger;
};

export type InboundWorkerHandle = { stop(): Promise<void> };

export type ConsumeOnceResult = {
  /** 这条流上收到的帧数（含重复 / 失败的） */
  frames: number;
  /** aborted = stop()；disconnected = 网关掐断 / 网关不可用 / 库不可用（都带 err） */
  reason: "aborted" | "disconnected";
  err?: unknown;
};

/** 默认的可打断等待：signal abort 时立即 resolve */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 一条流上的游标位置（见文件头）：只沿连号前进。received() 在每条事件 ingest 之后调，返回游标新推进到的位置
 * （没推进返回 null）。空洞等够了 GAP_SKIP_FRAMES 帧、GAP_SKIP_MS 毫秒就越过（onSkip 报告越过了哪段）。
 */
export function createCursorPosition(
  since: number,
  opts: {
    now?: () => number;
    gapFrames?: number;
    gapMs?: number;
    onSkip?: (missingFrom: number, missingTo: number) => void;
  } = {},
): {
  received(eventId: number): number | null;
} {
  const now = opts.now ?? Date.now;
  const gapFrames = opts.gapFrames ?? GAP_SKIP_FRAMES;
  const gapMs = opts.gapMs ?? GAP_SKIP_MS;
  let cursor = since;
  /** 比游标大、已处理、还没被游标越过的 id */
  const ahead = new Set<number>();
  /** 当前空洞从什么时候、第几帧开始卡住游标 */
  let stuck: { at: number; frames: number } | null = null;

  return {
    received(eventId) {
      const before = cursor;
      if (eventId > cursor) ahead.add(eventId);
      while (ahead.delete(cursor + 1)) cursor += 1;
      if (ahead.size === 0) {
        stuck = null;
      } else if (stuck === null || cursor !== before) {
        stuck = { at: now(), frames: 0 };
      } else {
        stuck.frames += 1;
        if (stuck.frames >= gapFrames && now() - stuck.at >= gapMs) {
          const next = Math.min(...ahead);
          opts.onSkip?.(cursor + 1, next - 1);
          cursor = next - 1;
          while (ahead.delete(cursor + 1)) cursor += 1;
          stuck = ahead.size === 0 ? null : { at: now(), frames: 0 };
        }
      }
      return cursor !== before ? cursor : null;
    },
  };
}

/**
 * 连一次流并消费到断开为止（可单独 await，测试用）：读游标 → openEventStream({ since }) → 每帧 ingest →
 * 按连号推进游标（见文件头）。返回为什么结束。不做重连、不做退避。
 */
export async function consumeOnce(
  deps: InboundWorkerDeps,
  signal: AbortSignal,
): Promise<ConsumeOnceResult> {
  const log = deps.log ?? logger;
  const cursor = deps.cursorStore ?? {
    read: readCursor,
    advance: (eventId) => advanceCursor(eventId, { clock: deps.clock }),
  };
  let frames = 0;
  // 这条流自己的中止：外面 stop()，或空闲超时
  const stream = new AbortController();
  const onStop = (): void => stream.abort();
  signal.addEventListener("abort", onStop, { once: true });
  let idle = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      stream.abort();
    }, deps.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS);
  };
  try {
    const since = (await cursor.read()) ?? 0;
    const position = createCursorPosition(since, {
      onSkip: (from, to) =>
        log.warn(
          { missingFrom: from, missingTo: to },
          "事件 id 有空洞且久等不来，游标越过它（网关的 id 不保证连续）",
        ),
    });
    log.info({ since }, "连接网关事件流");
    armIdle();
    for await (const event of deps.gateway.openEventStream({
      since,
      signal: stream.signal,
    })) {
      armIdle();
      frames += 1;
      const result = await ingest(event, {
        clock: deps.clock,
        log,
        applyGatewayDelivery: deps.applyGatewayDelivery,
      });
      const advanced = position.received(result.eventId);
      if (advanced !== null) await cursor.advance(advanced);
      if (signal.aborted || idle) break;
    }
    if (signal.aborted) return { frames, reason: "aborted" };
    return idle
      ? { frames, reason: "disconnected", err: new Error("事件流空闲超时") }
      : { frames, reason: "disconnected" };
  } catch (err) {
    if (signal.aborted) return { frames, reason: "aborted", err };
    return { frames, reason: "disconnected", err };
  } finally {
    clearTimeout(idleTimer);
    signal.removeEventListener("abort", onStop);
  }
}

export function startInboundWorker(
  deps: InboundWorkerDeps,
): InboundWorkerHandle {
  const runId = `inbound-${deps.clock.now().getTime().toString(36)}`;
  const log = (deps.log ?? logger).child({ worker: "inbound", runId });
  const sleep = deps.sleep ?? abortableSleep;
  const controller = new AbortController();
  const { signal } = controller;

  const loop = (async () => {
    let failures = 0;
    while (!signal.aborted) {
      const result = await consumeOnce({ ...deps, log }, signal);
      if (result.reason === "aborted") break;
      failures = result.frames > 0 ? 1 : failures + 1;
      const delay =
        Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_CAP_MS) +
        randomInt(0, RECONNECT_JITTER_MS + 1);
      log.warn(
        { err: result.err, frames: result.frames, failures, delayMs: delay },
        "事件流断开，退避后带游标重连",
      );
      await sleep(delay, signal);
    }
    log.info("入站 worker 已停止");
  })().catch((err: unknown) => {
    // 循环体已经把每次的异常收进 result；走到这里只可能是 sleep / 日志本身出错
    log.error({ err }, "入站 worker 循环异常退出");
  });

  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
