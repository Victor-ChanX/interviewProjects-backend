// 限流到期恢复（题目 A1：rate_limited 在 retryAfterSeconds 后自动回到 online）。
// 排期在库里：accounts.rateLimitedUntil；这里的定时器只是「多久看一次」，重启后从库里的截止时刻继续。
// 每个 tick 调 account-service 的 recoverRateLimited：到期且仍是 rate_limited 的才转移，
// 期间被改过的（状态变了 / until 被刷新）由它的 CAS 跳过。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑，stop() 立即返回。
import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import { recoverRateLimited } from "../services/account-service.js";

export type RateLimitWorkerDeps = {
  clock: Clock;
  /** 多久看一次（限流以秒计，1s 足够） */
  intervalMs: number;
  log?: Logger;
};

export type RateLimitWorkerHandle = { stop(): Promise<void> };

export function startRateLimitWorker(
  deps: RateLimitWorkerDeps,
): RateLimitWorkerHandle {
  const log = (deps.log ?? logger).child({ worker: "rate-limit" });
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
      const { due, recovered } = await recoverRateLimited({
        clock: deps.clock,
        log,
      });
      if (due > 0) log.info({ due, recovered }, "限流到期恢复");
    } catch (err) {
      log.error({ err }, "限流恢复 tick 失败");
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
