// 出站派发循环（issue #7）。只编排，不写业务判断：业务全在 src/services/outbox-service.ts。
//
// 两个循环：
// - 派发（runDispatchTick）= 领取一批（SKIP LOCKED，每个账号至多一条）→ **并发**调网关并记账。
//   一批里的消息分属不同账号，互不影响；逐条串行的话一次 send 最慢要十几秒，后面的全被拖住。
// - 确认（runConfirmTick）= 回收过期领取（领取者死了 → unknown）→ unknown 按 by-client-id 确认（确认未发出的回
//   queued）。单独一个循环：派发时一次 send
//   可能挂十几秒，确认不能排在它后面等（A2：收到 504 起 5 秒内定态）。
// runOutboxTick = 确认 + 派发，按顺序跑一遍（测试直接 await 它，不起循环）；「确认未发出 → 重发」落在同一个 tick 里。
// 写法是 while + 可打断的 sleep 而不是 setInterval：tick 慢于间隔时不会叠着跑（同一批被领两次的来源之一），
// stop() 立即打断等待、等在途 tick 完成后返回（优雅停机：不在外部调用中途退出，那正是制造 unknown 的方法）。
// 排期本身在库里（messages.nextAttemptAt / unknownSince / lockedAt），定时器只是「多久看一次」；
// 「现在」从 deps.clock 取，测试传假时钟推进。runOutboxTick 单独导出，测试直接 await 它，不起循环。
import { hostname } from "node:os";

import type { Clock } from "../core/clock.js";
import { logger, type Logger } from "../core/logger.js";
import type { GatewayClient } from "../services/gateway-client.js";
import {
  claimBatch,
  DEFAULT_BATCH_SIZE,
  dispatchOne,
  type DispatchOutcome,
  recoverStaleClaims,
  resolveUnknown,
} from "../services/outbox-service.js";

export type OutboxTickDeps = {
  clock: Clock;
  gateway: GatewayClient;
  /** 领取标记 claimedBy 的值；多副本各不相同 */
  workerId: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** 一次 tick 最多领几条 */
  batchSize?: number;
};

export type OutboxWorkerDeps = OutboxTickDeps & {
  /** 多久看一次（A2 的 5 秒定态要求 ≤ 500ms） */
  intervalMs: number;
  /** 可注入的等待；默认 setTimeout。返回 { promise, cancel }：stop() 用 cancel 立刻打断 */
  sleep?: (ms: number) => { promise: Promise<void>; cancel: () => void };
};

export type OutboxWorkerHandle = { stop(): Promise<void> };

export type OutboxTickStats = {
  recovered: number;
  unknownChecked: number;
  claimed: number;
  outcomes: Record<DispatchOutcome, number>;
};

/** 默认 workerId：主机名 + pid + 随机尾巴，多副本 / 同机多进程都不撞 */
export function defaultWorkerId(): string {
  return `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 确认 + 派发按顺序跑一遍（测试用）。每一步各自 try/catch：一条坏消息不能让整个 tick 停掉。 */
export async function runOutboxTick(
  deps: OutboxTickDeps,
): Promise<OutboxTickStats> {
  const confirmed = await runConfirmTick(deps);
  const stats = await runDispatchTick(deps);
  return { ...stats, ...confirmed };
}

function serviceDepsOf(deps: OutboxTickDeps) {
  const log =
    deps.log ?? logger.child({ worker: "outbox", workerId: deps.workerId });
  return {
    clock: deps.clock,
    log,
    gateway: deps.gateway,
    workerId: deps.workerId,
  };
}

/** 回收过期领取 → unknown 按 by-client-id 确认；返回回收了几条、查了几条。 */
export async function runConfirmTick(
  deps: OutboxTickDeps,
): Promise<{ recovered: number; unknownChecked: number }> {
  const serviceDeps = serviceDepsOf(deps);
  const result = { recovered: 0, unknownChecked: 0 };
  try {
    result.recovered = await recoverStaleClaims(deps.clock.now(), serviceDeps);
  } catch (err) {
    serviceDeps.log.error({ err }, "回收过期领取失败");
  }
  try {
    const r = await resolveUnknown(
      serviceDeps,
      deps.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    result.unknownChecked = r.checked;
  } catch (err) {
    serviceDeps.log.error({ err }, "确认 unknown 失败");
  }
  return result;
}

/** 领取一批 → 并发派发（一批里每个账号至多一条，互不影响）。 */
export async function runDispatchTick(
  deps: OutboxTickDeps,
): Promise<OutboxTickStats> {
  const serviceDeps = serviceDepsOf(deps);
  const { log } = serviceDeps;
  const stats: OutboxTickStats = {
    recovered: 0,
    unknownChecked: 0,
    claimed: 0,
    outcomes: {
      accepted: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
      requeued: 0,
      lost: 0,
    },
  };

  let claimed: Awaited<ReturnType<typeof claimBatch>> = [];
  try {
    claimed = await claimBatch(
      deps.workerId,
      deps.clock.now(),
      deps.batchSize ?? DEFAULT_BATCH_SIZE,
    );
  } catch (err) {
    log.error({ err }, "领取出站消息失败");
  }
  stats.claimed = claimed.length;

  await Promise.all(
    claimed.map(async (msg) => {
      try {
        const outcome = await dispatchOne(msg, serviceDeps);
        stats.outcomes[outcome] += 1;
      } catch (err) {
        // dispatchOne 自己兜底了记账；到这里的是记账本身抛了（库不可用）。行留着 claimedBy，由回收步骤处理。
        log.error(
          { err, messageId: msg.id, clientMsgId: msg.clientMsgId },
          "派发记账失败",
        );
      }
    }),
  );
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

export function startOutboxWorker(deps: OutboxWorkerDeps): OutboxWorkerHandle {
  const log =
    deps.log ?? logger.child({ worker: "outbox", workerId: deps.workerId });
  const sleep = deps.sleep ?? defaultSleep;
  let stopped = false;
  const pending = new Set<{ cancel: () => void }>();

  const every = async (tick: () => Promise<void>): Promise<void> => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      const s = sleep(deps.intervalMs);
      pending.add(s);
      await s.promise;
      pending.delete(s);
    }
  };

  const dispatchLoop = every(async () => {
    try {
      const stats = await runDispatchTick({ ...deps, log });
      if (stats.claimed > 0) {
        log.info(stats, "outbox 派发");
      }
    } catch (err) {
      log.error({ err }, "outbox 派发 tick 失败");
    }
  });
  const confirmLoop = every(async () => {
    try {
      const r = await runConfirmTick({ ...deps, log });
      if (r.recovered > 0 || r.unknownChecked > 0) {
        log.info(r, "outbox 回收 / 确认 unknown");
      }
    } catch (err) {
      log.error({ err }, "outbox 确认 tick 失败");
    }
  });

  return {
    // 优雅停机：不再开始新 tick → 打断等待 → 等在途 tick 完成
    async stop() {
      stopped = true;
      for (const s of pending) s.cancel();
      await Promise.all([dispatchLoop, confirmLoop]);
    },
  };
}
