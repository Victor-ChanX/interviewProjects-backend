// 后台循环样例。setInterval 只表示「多久看一次」，不是排期本身；
// 排期 / 进度落库，重启后从库里继续。Clock 可注入，测试用假时钟。
import type { Clock } from "../core/clock.js";
import { logger } from "../core/logger.js";
import { countActiveExamples } from "../services/example-service.js";

export type ExampleWorkerDeps = {
  clock: Clock;
  intervalMs: number;
};

export type WorkerHandle = { stop(): Promise<void> };

export function startExampleWorker(deps: ExampleWorkerDeps): WorkerHandle {
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const tick = async (): Promise<void> => {
    const startedAt = deps.clock.now();
    try {
      const active = await countActiveExamples();
      logger.info(
        { active, at: startedAt.toISOString() },
        "example-worker tick",
      );
    } catch (err) {
      logger.error({ err }, "example-worker tick 失败");
    }
  };

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = tick().finally(() => {
      inFlight = undefined;
    });
  }, deps.intervalMs);

  return {
    // 优雅停机：停领取 → 等在途完成
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}
