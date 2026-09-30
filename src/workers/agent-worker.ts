// Agent run 执行循环（issue #12）。只编排，不写业务判断：循环、上限、审计、工具全在 src/services/agent-run-service.ts。
//
// tick = 领一个 running 且没人持有的 run（FOR UPDATE SKIP LOCKED；心跳过期的也能接手）→ 一步一步跑到 run 终态
// （或 stop() / maxStepsPerTick）→ 释放（当前活跃段折进 accumulatedMs，停机期间不计预算）。
// 常驻循环同时跑最多 maxConcurrentRuns 个 run（各群互不等待）：一个 run 一步可能要十几秒（turn 超时 + 审计），
// 一次只跑一个的话，同时触发的几个群要排队几分钟，而 60 秒预算从 run 创建起算。
// 领着的期间每步刷心跳；进程死了，别的副本在 STALE_HEARTBEAT_MS 后接手，从库里的中断处续（每步先落库再产生副作用）。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑；stop() 打断等待、等在途的步完成
// （不在 /agent/turn 或网关调用中途退出）后释放 run。
// 「现在」从 deps.clock 取，等待用 deps.sleep（默认 setTimeout；service 里不许 setTimeout，所以由这里注入）。
// runAgentTick 单独导出，测试直接 await 它、传 maxStepsPerTick: 1 逐步驱动。
import { hostname } from "node:os";

import type { Clock } from "../core/clock.js";
import { config } from "../core/config.js";
import { logger, type Logger } from "../core/logger.js";
import type { AgentClient } from "../services/agent-client.js";
import {
  type AgentRunDeps,
  type Checkpoint,
  claimRun,
  releaseRun,
  runStep,
  type StepOutcome,
} from "../services/agent-run-service.js";
import type { GatewayClient } from "../services/gateway-client.js";

export type AgentTickDeps = {
  clock: Clock;
  agent: AgentClient;
  gateway: GatewayClient;
  /** 领取标记 claimedBy 的值；多副本各不相同 */
  workerId: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** /agent/turn 每轮超时；默认 config.agentTurnTimeoutMs（AGENT_TURN_TIMEOUT_MS，12s） */
  turnTimeoutMs?: number;
  /** /agent/audit 单次超时；默认 config.agentAuditTimeoutMs */
  auditTimeoutMs?: number;
  /** 一个 tick 最多跑几步（测试逐步驱动用）；默认跑到 run 终态 */
  maxStepsPerTick?: number;
  /** 等待实现（轮询 messages / 成员列表）；默认 setTimeout，测试注入假的 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试用：在 service 的「缝」上抛错模拟进程死亡 */
  checkpoint?: (point: Checkpoint) => Promise<void>;
  /** 循环用：true 时不再开始新的一步 */
  shouldStop?: () => boolean;
  /** worker 实例启动的时刻：第一次领取的 run 只把这之后的排队时间算进预算（之前可能是停机）；不给 = 从创建起全算 */
  workerStartedAt?: Date;
};

export const DEFAULT_MAX_CONCURRENT_RUNS = 8;

export type AgentWorkerDeps = AgentTickDeps & {
  /** 多久看一次有没有待执行的 run */
  intervalMs: number;
  /** 同时跑的 run 数上限；默认 DEFAULT_MAX_CONCURRENT_RUNS */
  maxConcurrentRuns?: number;
  /** 可注入的可打断等待；默认 setTimeout */
  wait?: (ms: number) => { promise: Promise<void>; cancel: () => void };
};

export type AgentWorkerHandle = { stop(): Promise<void> };

export type AgentTickResult = {
  runId: string;
  /** 本 tick 跑了几步 */
  steps: number;
  outcome: StepOutcome | "stopped";
};

/** 默认 workerId：主机名 + pid + 随机尾巴，多副本 / 同机多进程都不撞 */
export function defaultAgentWorkerId(): string {
  return `agent-${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一个 tick：领一个 run，跑到终态 / 被叫停 / 达到 maxStepsPerTick，然后释放。没有可领的返回 null。
 * 一步抛错（库不可用、测试的假崩溃）→ 记日志、释放 run，下个 tick 从中断处续；不让一个 run 卡死整个 worker。
 */
export async function runAgentTick(
  deps: AgentTickDeps,
): Promise<AgentTickResult | null> {
  const log =
    deps.log ?? logger.child({ worker: "agent", workerId: deps.workerId });
  const runId = await claimRun(deps.workerId, deps.clock.now(), {
    ...(deps.workerStartedAt ? { workerStartedAt: deps.workerStartedAt } : {}),
  });
  if (!runId) return null;
  return driveRun(runId, { ...deps, log });
}

/** 已领到的 run：一步一步跑到终态 / 被叫停 / 达到 maxStepsPerTick，然后释放。 */
export async function driveRun(
  runId: string,
  deps: AgentTickDeps,
): Promise<AgentTickResult> {
  const log =
    deps.log ?? logger.child({ worker: "agent", workerId: deps.workerId });
  const serviceDeps: AgentRunDeps = {
    clock: deps.clock,
    log,
    agent: deps.agent,
    gateway: deps.gateway,
    workerId: deps.workerId,
    turnTimeoutMs: deps.turnTimeoutMs ?? config.agentTurnTimeoutMs,
    auditTimeoutMs: deps.auditTimeoutMs ?? config.agentAuditTimeoutMs,
    sleep: deps.sleep ?? realSleep,
    ...(deps.checkpoint ? { checkpoint: deps.checkpoint } : {}),
  };
  let steps = 0;
  let outcome: AgentTickResult["outcome"] = "stopped";
  try {
    for (;;) {
      if (deps.shouldStop?.()) break;
      if (deps.maxStepsPerTick !== undefined && steps >= deps.maxStepsPerTick) {
        break;
      }
      const r = await runStep(runId, serviceDeps);
      steps += 1;
      if (r !== "continue") {
        outcome = r;
        break;
      }
    }
  } catch (err) {
    log.error(
      { err, runId, steps },
      "agent run 的一步异常中断，释放后由下个 tick 续",
    );
  } finally {
    await releaseRun(runId, deps.workerId, deps.clock.now());
  }
  return { runId, steps, outcome };
}

function defaultWait(ms: number): {
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

export function startAgentWorker(deps: AgentWorkerDeps): AgentWorkerHandle {
  const log =
    deps.log ?? logger.child({ worker: "agent", workerId: deps.workerId });
  const wait = deps.wait ?? defaultWait;
  const maxConcurrent = deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const workerStartedAt = deps.workerStartedAt ?? deps.clock.now();
  const inflight = new Set<Promise<void>>();
  let stopped = false;
  let pending: { cancel: () => void } | undefined;

  const tickDeps: AgentTickDeps = {
    ...deps,
    log,
    workerStartedAt,
    shouldStop: () => stopped,
  };

  /** 有空位就领一个 run 在后台跑；领到返回 true */
  const claimOne = async (): Promise<boolean> => {
    const runId = await claimRun(deps.workerId, deps.clock.now(), {
      workerStartedAt,
    });
    if (!runId) return false;
    const task: Promise<void> = driveRun(runId, tickDeps)
      .then((result) => {
        log.info(result, "agent run 驱动结束");
      })
      .catch((err: unknown) => {
        log.error({ err, runId }, "agent run 驱动失败");
      })
      .finally(() => {
        inflight.delete(task);
        // 跑完一个就立刻看有没有下一个（pending 合并出来的 run 不该等一个间隔）
        pending?.cancel();
      });
    inflight.add(task);
    return true;
  };

  const loop = (async () => {
    while (!stopped) {
      try {
        while (!stopped && inflight.size < maxConcurrent) {
          if (!(await claimOne())) break;
        }
      } catch (err) {
        log.error({ err }, "领取 agent run 失败");
      }
      if (stopped) break;
      const s = wait(deps.intervalMs);
      pending = s;
      await s.promise;
      pending = undefined;
    }
    // 优雅停机：在途的 run 各自在当前步之后停下并释放
    await Promise.all([...inflight]);
  })();

  return {
    // 优雅停机：不再领新的 run、不再开始新的一步 → 打断等待 → 等在途的步完成并释放 run
    async stop() {
      stopped = true;
      pending?.cancel();
      await loop;
    },
  };
}
