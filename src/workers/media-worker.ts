// 媒体文件（题目 C1）：两个循环，业务全在 src/services/media-service.ts。
// - 下载：每 downloadIntervalMs 领一批到期的（messages.mediaNextAttemptAt）下载到本地。
// - 清理：每 purgeIntervalMs 删一次超过保留期的文件（先清记录再删文件）、扫孤儿、对账丢失的文件；启动时先跑一次。
// 排期在库里（mediaNextAttemptAt / mediaFetchedAt），定时器只是「多久看一次」。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑，stop() 立即返回。
import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import type { GatewayClient } from "../services/gateway-client.js";
import {
  downloadDueMedia,
  type MediaStore,
  purgeExpiredMedia,
} from "../services/media-service.js";

export type MediaWorkerDeps = {
  clock: Clock;
  gateway: Pick<GatewayClient, "downloadMedia">;
  store: MediaStore;
  retentionDays: number;
  downloadIntervalMs: number;
  purgeIntervalMs: number;
  log?: Logger;
};

export type MediaWorkerHandle = { stop(): Promise<void> };

export function startMediaWorker(deps: MediaWorkerDeps): MediaWorkerHandle {
  const log = (deps.log ?? logger).child({ worker: "media" });
  let stopped = false;
  const wakers = new Set<() => void>();

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });

  const every = async (
    intervalMs: number,
    tick: () => Promise<void>,
  ): Promise<void> => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await sleep(intervalMs);
    }
  };

  const downloadLoop = every(deps.downloadIntervalMs, async () => {
    try {
      const r = await downloadDueMedia({
        clock: deps.clock,
        gateway: deps.gateway,
        store: deps.store,
        log,
      });
      if (r.claimed > 0) log.info(r, "媒体文件下载");
    } catch (err) {
      log.error({ err }, "媒体文件下载 tick 失败");
    }
  });
  const purgeLoop = every(deps.purgeIntervalMs, async () => {
    try {
      await purgeExpiredMedia({
        clock: deps.clock,
        store: deps.store,
        retentionDays: deps.retentionDays,
        log,
      });
    } catch (err) {
      log.error({ err }, "媒体文件清理 tick 失败");
    }
  });

  return {
    // 优雅停机：不再开始新 tick → 打断等待 → 等在途 tick 完成
    async stop() {
      stopped = true;
      for (const wake of [...wakers]) wake();
      await Promise.all([downloadLoop, purgeLoop]);
    },
  };
}
