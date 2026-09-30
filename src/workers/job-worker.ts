// 异步 job 循环（建群 #11；leave-all #16 复用）。只编排，不写业务判断：状态机全在
// src/services/group-job-service.ts。
//
// tick = 回收过期领取（lockedAt 过旧 = 领取者死了）→ 领取一批（SKIP LOCKED）→ 逐个 advanceJob（连续跑到
// 需要等待 / 终态 / 步数上限为止，然后释放领取并按 outcome 写 nextRunAt）。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑；stop() 立即打断等待、
// 等在途 tick 完成后返回（优雅停机：不在网关调用中途退出）。排期本身在库里（jobs.nextRunAt / lockedAt），
// 定时器只是「多久看一次」；「现在」从 deps.clock 取，测试传假时钟推进。runJobTick 单独导出，测试直接
// await 它，不起循环；maxStepsPerJob = 1 可以在任一步之后停住（重启恢复用例）。
import { hostname } from "node:os";

import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import {
  advanceJob,
  type AdvanceResult,
  claimJobs,
  DEFAULT_BATCH_SIZE,
  type JobGateway,
  recoverStaleJobClaims,
} from "../services/group-job-service.js";

export type JobTickDeps = {
  clock: Clock;
  gateway: JobGateway;
  /** 领取标记 claimedBy 的值；多副本各不相同 */
  workerId: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** 一次 tick 最多领几个 job */
  batchSize?: number;
  /** 一次领取里一个 job 最多连续跑几步（测试用 1 逐步推进） */
  maxStepsPerJob?: number;
};

export type JobWorkerDeps = JobTickDeps & {
  /** 多久看一次（join 等待按 200ms 排期，间隔别比它大太多） */
  intervalMs: number;
  /** 可注入的等待；默认 setTimeout。返回 { promise, cancel }：stop() 用 cancel 立刻打断 */
  sleep?: (ms: number) => { promise: Promise<void>; cancel: () => void };
};

export type JobWorkerHandle = { stop(): Promise<void> };

export type JobTickStats = {
  recovered: number;
  claimed: number;
  results: AdvanceResult[];
};

/** 默认 workerId：主机名 + pid + 随机尾巴，多副本 / 同机多进程都不撞 */
export function defaultJobWorkerId(): string {
  return `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 一个 tick 的全部工作。每一步各自 try/catch：一个坏 job 不能让整个 tick 停掉。 */
export async function runJobTick(deps: JobTickDeps): Promise<JobTickStats> {
  const log =
    deps.log ?? logger.child({ worker: "job", workerId: deps.workerId });
  const stats: JobTickStats = { recovered: 0, claimed: 0, results: [] };
  const serviceDeps = {
    clock: deps.clock,
    gateway: deps.gateway,
    workerId: deps.workerId,
    log,
  };

  try {
    stats.recovered = await recoverStaleJobClaims(deps.clock.now(), { log });
  } catch (err) {
    log.error({ err }, "回收过期领取失败");
  }

  let claimed: Awaited<ReturnType<typeof claimJobs>> = [];
  try {
    claimed = await claimJobs(
      deps.workerId,
      deps.clock.now(),
      deps.batchSize ?? DEFAULT_BATCH_SIZE,
    );
  } catch (err) {
    log.error({ err }, "领取 job 失败");
  }
  stats.claimed = claimed.length;

  for (const job of claimed) {
    try {
      const result = await advanceJob(job.id, serviceDeps, {
        maxSteps: deps.maxStepsPerJob,
      });
      stats.results.push(result);
    } catch (err) {
      // advanceJob 自己兜底了步骤异常；到这里的是记账本身抛了（库不可用）。行留着 claimedBy，由回收步骤处理。
      log.error({ err, jobId: job.id, step: job.step }, "推进 job 失败");
    }
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

export function startJobWorker(deps: JobWorkerDeps): JobWorkerHandle {
  const log =
    deps.log ?? logger.child({ worker: "job", workerId: deps.workerId });
  const sleep = deps.sleep ?? defaultSleep;
  let stopped = false;
  let pending: { cancel: () => void } | undefined;

  const loop = (async () => {
    while (!stopped) {
      try {
        const stats = await runJobTick({ ...deps, log });
        if (stats.claimed > 0 || stats.recovered > 0) {
          log.info(
            {
              recovered: stats.recovered,
              claimed: stats.claimed,
              results: stats.results,
            },
            "job tick",
          );
        }
      } catch (err) {
        log.error({ err }, "job tick 失败");
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
      await loop;
    },
  };
}
