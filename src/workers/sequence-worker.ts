// 定时序列循环（题目 B1；issue #15）。只编排，不写业务判断：选账号 / 排期 / 重启重排全在
// src/services/sequence-service.ts。
//
// tick = 反复「领一个到点的 running run（FOR UPDATE SKIP LOCKED）→ 推进 → commit」直到没有到点的或达到批量上限。
// 每个 run 一个事务：一个坏 run 不影响同一 tick 里的其他 run；进程死在任一次 commit 之后，下一次 tick 从库里的
// 状态继续。出站入队（outbox-service.enqueueMessageInTx）在这里注入给 service —— outbox-service 反向依赖
// sequence-service（消息终局推进步骤），service 自己 import 会成环。
//
// 排期本身在库里（sequence_run_steps.scheduledAt），定时器只是「多久看一次」；「现在」从 deps.clock 取，测试传假时钟
// 推进。心跳由独立定时器每 SCHEDULER_HEARTBEAT_INTERVAL_MS 刷新一次（tick 慢不会被误判为停机，后端 #53），每个 tick
// 开头也刷新一次并拿到最近一次停机空档（recordSchedulerBeat）：到点时刻落在空档里、仍 pending
// 的当前步是停机期间过期的那一步，service 只重排这一步（rescheduleStaleStep），后续步骤仍按前一步发出后排。
// workerStartedAt（本实例启动时刻）只在库里还没有任何心跳（第一次启动）时作为空档的终点。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑；stop() 立即打断等待、等在途 tick
// 完成后返回。runSequenceTick 单独导出，测试直接 await 它，不起循环。
import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import { enqueueMessageInTx } from "../services/outbox-service.js";
import {
  type AdvanceResult,
  advanceNextDue,
  DEFAULT_BATCH_SIZE,
  recordSchedulerBeat,
  SCHEDULER_HEARTBEAT_INTERVAL_MS,
} from "../services/sequence-service.js";

export type SequenceTickDeps = {
  clock: Clock;
  /** 本 worker 实例的启动时刻：第一次启动（库里没有心跳）时作为停机空档的终点；不传 = 不做重启重排 */
  workerStartedAt?: Date;
  /** 两次心跳之间隔多久算停过；默认 SCHEDULER_DOWNTIME_GAP_MS */
  downtimeGapMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** 一次 tick 最多推进几个 run */
  batchSize?: number;
};

export type SequenceWorkerDeps = Omit<SequenceTickDeps, "workerStartedAt"> & {
  /** 多久看一次（delaySeconds 以秒计，1s 足够） */
  intervalMs: number;
  /** 调度器心跳间隔；默认 SCHEDULER_HEARTBEAT_INTERVAL_MS */
  heartbeatIntervalMs?: number;
  /** 可注入的等待；默认 setTimeout。返回 { promise, cancel }：stop() 用 cancel 立刻打断 */
  sleep?: (ms: number) => { promise: Promise<void>; cancel: () => void };
};

export type SequenceWorkerHandle = { stop(): Promise<void> };

export type SequenceTickStats = {
  advanced: number;
  results: AdvanceResult[];
};

/** 一个 tick 的全部工作。每个 run 各自 try/catch：一个坏 run 不能让整个 tick 停掉。 */
export async function runSequenceTick(
  deps: SequenceTickDeps,
): Promise<SequenceTickStats> {
  const log = deps.log ?? logger.child({ worker: "sequence" });
  const stats: SequenceTickStats = { advanced: 0, results: [] };
  const limit = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const downtime = deps.workerStartedAt
    ? await recordSchedulerBeat(deps.clock.now(), {
        workerStartedAt: deps.workerStartedAt,
        ...(deps.downtimeGapMs !== undefined
          ? { gapMs: deps.downtimeGapMs }
          : {}),
      })
    : undefined;
  for (let i = 0; i < limit; i += 1) {
    let result: AdvanceResult | null;
    try {
      result = await advanceNextDue({
        clock: deps.clock,
        log,
        enqueue: enqueueMessageInTx,
        ...(downtime ? { downtime } : {}),
      });
    } catch (err) {
      // 推进本身抛了（库不可用 / 约束冲突）：事务已回滚，run 留在原状态，下个 tick 再试
      log.error({ err }, "推进序列运行失败");
      break;
    }
    if (!result) break;
    stats.advanced += 1;
    stats.results.push(result);
  }
  return stats;
}

function defaultSleep(ms: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let cancel: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

export function startSequenceWorker(
  deps: SequenceWorkerDeps,
): SequenceWorkerHandle {
  const log = deps.log ?? logger.child({ worker: "sequence" });
  const sleep = deps.sleep ?? defaultSleep;
  // 启动时刻只取一次：库里还没有任何调度器心跳（第一次启动）时，它是停机空档的终点
  const workerStartedAt = deps.clock.now();
  let stopped = false;
  let pending: { cancel: () => void } | undefined;
  let heartbeatWait: { cancel: () => void } | undefined;

  // 心跳独立于 tick：一个 tick 推进很多 run、或库慢时 tick 可能远超间隔，那不是停机，心跳照跳
  const heartbeat = (async () => {
    while (!stopped) {
      try {
        await recordSchedulerBeat(deps.clock.now(), {
          workerStartedAt,
          ...(deps.downtimeGapMs !== undefined
            ? { gapMs: deps.downtimeGapMs }
            : {}),
        });
      } catch (err) {
        log.error({ err }, "调度器心跳写入失败");
      }
      if (stopped) break;
      const s = sleep(
        deps.heartbeatIntervalMs ?? SCHEDULER_HEARTBEAT_INTERVAL_MS,
      );
      heartbeatWait = s;
      await s.promise;
      heartbeatWait = undefined;
    }
  })();

  const loop = (async () => {
    while (!stopped) {
      try {
        const stats = await runSequenceTick({ ...deps, log, workerStartedAt });
        if (stats.advanced > 0) {
          log.info(
            { advanced: stats.advanced, results: stats.results },
            "sequence tick",
          );
        }
      } catch (err) {
        log.error({ err }, "sequence tick 失败");
      }
      if (stopped) break;
      const s = sleep(deps.intervalMs);
      pending = s;
      await s.promise;
      pending = undefined;
    }
  })();

  return {
    // 优雅停机：不再开始新 tick → 打断等待 → 等在途 tick 完成
    async stop() {
      stopped = true;
      pending?.cancel();
      heartbeatWait?.cancel();
      await Promise.all([loop, heartbeat]);
    },
  };
}
