// 入站事件重试（题目 A2：处理网关事件时写库失败，不能让这个事件的内容丢失）。
// 排期在库里：inbound_events.nextAttemptAt（处理失败按退避排；入册时先排上孤儿宽限，进程死在入册与处理之间也会被接手）。
// 每个 tick 调 inbound-service 的 retryDueEvents：领取到期行（FOR UPDATE SKIP LOCKED + 租约，多副本各领各的）→ 逐条重新处理。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑，stop() 立即返回。
import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import {
  type ApplyGatewayDelivery,
  retryDueEvents,
} from "../services/inbound-service.js";

export type InboundRetryWorkerDeps = {
  clock: Clock;
  /** 与入站 worker 同一个记账函数（outbox-service.applyGatewayDelivery） */
  applyGatewayDelivery: ApplyGatewayDelivery;
  /** 多久看一次（退避以秒计，1s 足够） */
  intervalMs: number;
  log?: Logger;
};

export type InboundRetryWorkerHandle = { stop(): Promise<void> };

export function startInboundRetryWorker(
  deps: InboundRetryWorkerDeps,
): InboundRetryWorkerHandle {
  const log = (deps.log ?? logger).child({ worker: "inbound-retry" });
  let stopped = false;
  let wake: (() => void) | undefined;

  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, deps.intervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  const tick = async (): Promise<void> => {
    try {
      const result = await retryDueEvents({
        clock: deps.clock,
        log,
        applyGatewayDelivery: deps.applyGatewayDelivery,
      });
      if (result.claimed > 0) log.info(result, "入站事件重试");
    } catch (err) {
      log.error({ err }, "入站事件重试 tick 失败");
    }
  };

  const loop = (async () => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await sleep();
    }
  })();

  return {
    // 优雅停机：不再开始新 tick → 打断等待 → 等在途 tick 完成
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
