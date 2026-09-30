// 事件类表的保留期清理循环（后端 #57）：每 intervalMs 调一次 retention-service.purgeOldEvents，启动时先跑一次。
// 删除条件全由「现在」与库里的时间列决定，定时器只是「多久看一次」；多副本同时跑也只是各删各的批次（按 id 删，重复
// 删同一行是空操作）。写法是 while + 可打断的 sleep：stop() 立即返回。
import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import { purgeOldEvents } from "../services/retention-service.js";

export type RetentionWorkerDeps = {
  clock: Clock;
  intervalMs: number;
  log?: Logger;
};

export type RetentionWorkerHandle = { stop(): Promise<void> };

export function startRetentionWorker(
  deps: RetentionWorkerDeps,
): RetentionWorkerHandle {
  const log = (deps.log ?? logger).child({ worker: "retention" });
  let stopped = false;
  let wake: (() => void) | undefined;

  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await purgeOldEvents(deps.clock.now());
        const total =
          r.wsEvents + r.inboundEvents + r.outboundAttempts + r.loginThrottles;
        if (total > 0) log.info(r, "已按保留期清理事件表");
      } catch (err) {
        log.error({ err }, "保留期清理失败");
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, deps.intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
