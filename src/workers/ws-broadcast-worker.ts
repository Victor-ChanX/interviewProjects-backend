// WebSocket 广播循环（issue #9）：每 pollIntervalMs 调一次 ws-hub 的 pump()，把 ws_events 的新行推给已认证连接、
// 关掉认证超时的连接。排期不在这里：水位（推到哪）在 hub 里、事件在 ws_events 表里，定时器只是「多久看一次」。
// 写法是 while + 可打断的 sleep 而不是 setInterval：pump 慢于间隔时不会叠着跑，stop() 立即返回。
import { logger, type Logger } from "../core/logger.js";
import type { WsHub } from "../services/ws-hub.js";

export type WsBroadcastWorkerDeps = {
  hub: WsHub;
  /** 多久看一次 ws_events（题目要求断线重连 3 秒内补齐、实时事件秒级到达，200ms 足够） */
  pollIntervalMs: number;
  log?: Logger;
};

export type WsBroadcastWorkerHandle = { stop(): Promise<void> };

export function startWsBroadcastWorker(
  deps: WsBroadcastWorkerDeps,
): WsBroadcastWorkerHandle {
  const log = (deps.log ?? logger).child({ worker: "ws-broadcast" });
  let stopped = false;
  let wake: (() => void) | undefined;

  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, deps.pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  const tick = async (): Promise<void> => {
    try {
      const { delivered, authTimedOut } = await deps.hub.pump();
      if (authTimedOut > 0) {
        log.info({ authTimedOut }, "关闭认证超时的 WebSocket 连接");
      }
      if (delivered > 0) log.debug({ delivered }, "推送事件帧");
    } catch (err) {
      log.error({ err }, "ws 广播 tick 失败");
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
