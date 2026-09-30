// 入站 SSE worker（issue #8）：读游标 → 带 since 连网关事件流 → 逐条 ingest → 推进游标 → 断了就退避重连。
//
// - 位置在库里（event_cursor.lastEventId），不在内存：重启 / 断线都从游标之后补拉（题目 A2：停机或断流期间
//   的事件恢复后都要处理到）。游标从未写过（首次启动）时不带 since —— 题目里不带 since = 从当前时刻开始；
//   要从头回放就把 event_cursor 手动置 0。
// - 一条一条处理：ingest 自己吞掉「处理失败」（入册 + 不一致记录），只在库不可用时抛；那时断开这条流、
//   退避后从游标重连，事件不会丢（游标没推进）。
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
 * 连一次流并消费到断开为止（可单独 await，测试用）：读游标 → openEventStream({ since }) → 每帧 ingest +
 * advanceCursor。返回为什么结束。不做重连、不做退避。
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
  try {
    const since = await cursor.read();
    log.info({ since }, "连接网关事件流");
    for await (const event of deps.gateway.openEventStream({ since, signal })) {
      frames += 1;
      const result = await ingest(event, {
        clock: deps.clock,
        log,
        applyGatewayDelivery: deps.applyGatewayDelivery,
      });
      await cursor.advance(result.eventId);
      if (signal.aborted) break;
    }
    return { frames, reason: signal.aborted ? "aborted" : "disconnected" };
  } catch (err) {
    if (signal.aborted) return { frames, reason: "aborted", err };
    return { frames, reason: "disconnected", err };
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
