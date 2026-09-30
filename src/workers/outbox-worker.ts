// 出站派发循环（issue #7）。只编排，不写业务判断：业务全在 src/services/outbox-service.ts。
//
// tick = 回收过期领取 → 确认 unknown（by-client-id；确认未发出的回 queued）→ 领取一批（SKIP LOCKED）→ 逐条
// 调网关并记账。先确认再领取，让「确认未发出 → 重发」落在同一个 tick 里（A2：收到 504 起 5 秒内定态）。
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

/** 一个 tick 的全部工作。每一步各自 try/catch：一条坏消息不能让整个 tick 停掉。 */
export async function runOutboxTick(
  deps: OutboxTickDeps,
): Promise<OutboxTickStats> {
  const log =
    deps.log ?? logger.child({ worker: "outbox", workerId: deps.workerId });
  const stats: OutboxTickStats = {
    recovered: 0,
    unknownChecked: 0,
    claimed: 0,
    outcomes: { accepted: 0, failed: 0, cancelled: 0, unknown: 0, requeued: 0 },
  };
  const serviceDeps = {
    clock: deps.clock,
    log,
    gateway: deps.gateway,
    workerId: deps.workerId,
  };

  try {
    stats.recovered = await recoverStaleClaims(deps.clock.now(), serviceDeps);
  } catch (err) {
    log.error({ err }, "回收过期领取失败");
  }

  try {
    const r = await resolveUnknown(
      serviceDeps,
      deps.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    stats.unknownChecked = r.checked;
  } catch (err) {
    log.error({ err }, "确认 unknown 失败");
  }

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

  for (const msg of claimed) {
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

export function startOutboxWorker(deps: OutboxWorkerDeps): OutboxWorkerHandle {
  const log =
    deps.log ?? logger.child({ worker: "outbox", workerId: deps.workerId });
  const sleep = deps.sleep ?? defaultSleep;
  let stopped = false;
  let pending: { cancel: () => void } | undefined;

  const loop = (async () => {
    while (!stopped) {
      try {
        const stats = await runOutboxTick({ ...deps, log });
        if (stats.claimed > 0 || stats.recovered > 0) {
          log.info(stats, "outbox tick");
        }
      } catch (err) {
        log.error({ err }, "outbox tick 失败");
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
