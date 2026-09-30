// 群状态（题目 2.3 groups.status：active | unreachable | left）。本文件目前只有 #7 需要的一件事：
// 网关回 GROUP_WRITE_FORBIDDEN（同步错误或 message_failed）时把群标成 unreachable 并级联（题目 A2 错误表）。
// 建群 / leave-all（#11 / #16）到时往这里加。
//
// 级联与状态写入同一事务，要么都生效、要么都不生效：
// - groups.status active → unreachable（已经不是 active 的群：no-op，返回 changed = false，不重复级联）；
// - 该群 running 的 sequence_runs → stopped（finishedAt = now），每条写一行 ws_events sequence_run；
// - 该群 queued 的出站消息 → cancelled（failCode = GROUP_UNREACHABLE）：不可写的群再往网关发只会一条条
//   403 回来；在途（claimed / accepted / unknown）的不动，由出站 worker 按网关的真实结果记账；
// - running 的 agent_runs：agent_runs 没有「请求取消」列，这里不改它的状态（A2 要求「当前步后 cancelled」，
//   由 agent 循环 #12 在每步之后读 groups.status 决定），只写一行 ws_events group_status_changed 让操作员看见。
//   计数 agentRunsRunning 返回给调用方（api.side-effect-count）。
// - 账号状态不变（题目原文）。
import { type Clock, systemClock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import { emitWsEvent } from "./ws-events.js";

/** 群不可写时给被取消的出站消息打的码（题目 2.3 messages 的 failCode 取值之一）。 */
export const GROUP_UNREACHABLE_FAIL_CODE = "GROUP_UNREACHABLE";

export type GroupServiceDeps = {
  clock?: Clock;
  /** 路由传 request.log；worker 传 logger.child({ runId }) */
  log?: Pick<Logger, "info" | "warn" | "error">;
};

export type MarkUnreachableResult = {
  /** false = 群已不是 active（已 unreachable / left），什么都没改 */
  changed: boolean;
  sequenceRunsStopped: number;
  messagesCancelled: number;
  /** 仍在 running 的 agent run 数：由 #12 的循环在当前步后自行 cancelled */
  agentRunsRunning: number;
};

/**
 * 网关说该群不可写（GROUP_WRITE_FORBIDDEN）：群 → unreachable + 级联，一个事务。
 * reason 只进日志与事件 payload（同步错误 / message_failed 两个来源结果一样）。
 */
export async function markGroupUnreachable(
  groupId: string,
  reason: string,
  deps: GroupServiceDeps = {},
): Promise<MarkUnreachableResult> {
  const clock = deps.clock ?? systemClock;
  const result = await getDb().$transaction(async (tx) => {
    const now = clock.now();
    const flipped = await tx.group.updateMany({
      where: { id: groupId, status: "active" },
      data: { status: "unreachable" },
    });
    if (flipped.count === 0) {
      return {
        changed: false,
        sequenceRunsStopped: 0,
        messagesCancelled: 0,
        agentRunsRunning: 0,
      } satisfies MarkUnreachableResult;
    }

    const runs = await tx.sequenceRun.findMany({
      where: { groupId, status: "running" },
      select: { id: true, currentStepIndex: true },
    });
    if (runs.length > 0) {
      await tx.sequenceRun.updateMany({
        where: { id: { in: runs.map((r) => r.id) } },
        data: { status: "stopped", finishedAt: now },
      });
      for (const run of runs) {
        await emitWsEvent(tx, "sequence_run", {
          runId: run.id,
          groupId,
          status: "stopped",
          currentStepIndex: run.currentStepIndex,
        });
      }
    }

    const queued = await tx.message.findMany({
      where: { groupId, deliveryStatus: "queued", claimedBy: null },
      select: { id: true, clientMsgId: true },
    });
    if (queued.length > 0) {
      await tx.message.updateMany({
        where: { id: { in: queued.map((m) => m.id) } },
        data: {
          deliveryStatus: "cancelled",
          failCode: GROUP_UNREACHABLE_FAIL_CODE,
        },
      });
      for (const m of queued) {
        await emitWsEvent(tx, "message", {
          groupId,
          msgId: null,
          clientMsgId: m.clientMsgId,
          isOwn: true,
          deliveryStatus: "cancelled",
          failCode: GROUP_UNREACHABLE_FAIL_CODE,
        });
      }
    }

    const agentRunsRunning = await tx.agentRun.count({
      where: { groupId, status: "running" },
    });

    await emitWsEvent(tx, "group_status_changed", {
      groupId,
      from: "active",
      to: "unreachable",
      reason,
    });

    return {
      changed: true,
      sequenceRunsStopped: runs.length,
      messagesCancelled: queued.length,
      agentRunsRunning,
    } satisfies MarkUnreachableResult;
  });

  // commit 之后才记业务日志
  if (result.changed) {
    deps.log?.warn({ groupId, reason, ...result }, "群已标为 unreachable");
  }
  return result;
}
