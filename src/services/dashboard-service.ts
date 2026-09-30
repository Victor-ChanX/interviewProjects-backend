// 工作台概览（#22：GET /api/dashboard/summary）：控制台首页的各组计数。
//
// 口径一致：所有计数在**同一个只读、REPEATABLE READ 事务**里取 —— Postgres 在该隔离级别下整个事务看同一个快照，
// 不会出现「账号合计按旧快照、分状态按新快照」这类对不上的数。每组是一条 count / groupBy（固定条数，无 N+1）。
// 交互式事务里查询在同一条连接上串行执行，所以逐条 await，不 Promise.all。
//
// 「今日」= 业务时区（src/core/business-day.ts 的 BUSINESS_TIME_ZONE）的自然日：[startOfBusinessDay(now), …)。
// 「现在」从可注入的 Clock 取（测试用假时钟造今日边界），dayStart 随响应下发。
//
// 各项口径（与 src/schemas/dashboard.ts 的注释一致）：
// - messages.todayInbound / todayOutbound：sentAt（时间线排序键）落在今日；出站 = outbox 行（deliveryStatus 非空），
//   入站 = 其余行。outboundFailed / Unknown / Queued 是当前处于该状态的出站行数，不限日期。
// - agentRuns.todayFinished / todayFailed、jobs.todayFailed：按 finishedAt 落在今日；blocked 为全部 blocked 的运行数。
// - inconsistencies.unresolved：resolvedAt 为 null。
//
// 数据范围：只有 admin / viewer 两种角色，登录用户都看全平台，没有归属键。
import {
  BUSINESS_TIME_ZONE,
  startOfBusinessDay,
} from "../core/business-day.js";
import { type Clock, systemClock } from "../core/clock.js";
import { getDb } from "../db/client.js";
import { AccountStatus, GroupStatus } from "../db/generated/enums.js";
import type { DashboardSummary } from "../schemas/dashboard.js";

export type DashboardDeps = { clock?: Clock };

/** groupBy 的结果按 key 摊成计数表，没出现的状态记 0 */
function tally<K extends string>(
  keys: readonly K[],
  rows: { key: K | null; count: number }[],
): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of rows) {
    if (r.key !== null && r.key in out) out[r.key] += r.count;
  }
  return out;
}

/** 工作台关心的出站投递状态（需要人看的：失败、结果未知、积压） */
const WATCHED_DELIVERY = ["failed", "unknown", "queued"] as const;
type WatchedDelivery = (typeof WATCHED_DELIVERY)[number];

export async function getDashboardSummary(
  deps: DashboardDeps = {},
): Promise<DashboardSummary> {
  const now = (deps.clock ?? systemClock).now();
  const dayStart = startOfBusinessDay(now);
  const today = { gte: dayStart };

  return getDb().$transaction(
    async (tx) => {
      // 只读：统计端点不该写任何东西；写了就是 bug，让库直接拒绝
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const accountRows = await tx.account.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const groupRows = await tx.group.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const agentEnabled = await tx.group.count({
        where: { agentEnabled: true },
      });
      const todayInbound = await tx.message.count({
        where: { deliveryStatus: null, sentAt: today },
      });
      const todayOutbound = await tx.message.count({
        where: { deliveryStatus: { not: null }, sentAt: today },
      });
      const deliveryRows = await tx.message.groupBy({
        by: ["deliveryStatus"],
        where: { deliveryStatus: { in: [...WATCHED_DELIVERY] } },
        _count: { _all: true },
      });
      const agentRunsRunning = await tx.agentRun.count({
        where: { status: "running" },
      });
      const agentRunsTodayFinished = await tx.agentRun.count({
        where: { status: "finished", finishedAt: today },
      });
      const agentRunsTodayFailed = await tx.agentRun.count({
        where: { status: "failed", finishedAt: today },
      });
      const agentRunsBlocked = await tx.agentRun.count({
        where: { status: "blocked" },
      });
      const sequenceRunsRunning = await tx.sequenceRun.count({
        where: { status: "running" },
      });
      const jobsRunning = await tx.job.count({ where: { status: "running" } });
      const jobsTodayFailed = await tx.job.count({
        where: { status: "failed", finishedAt: today },
      });
      const unresolved = await tx.inconsistency.count({
        where: { resolvedAt: null },
      });

      // 键表从生成的 enum 取：新增状态自动出现在计数里（schema 没跟上时 tsc 会红）
      const accounts = tally(
        Object.values(AccountStatus),
        accountRows.map((r) => ({ key: r.status, count: r._count._all })),
      );
      const groups = tally(
        Object.values(GroupStatus),
        groupRows.map((r) => ({ key: r.status, count: r._count._all })),
      );
      const delivery = tally(
        WATCHED_DELIVERY,
        deliveryRows.map((r) => ({
          // where 已限定在 WATCHED_DELIVERY 里
          key: r.deliveryStatus as WatchedDelivery | null,
          count: r._count._all,
        })),
      );
      const sum = (rec: Record<string, number>): number =>
        Object.values(rec).reduce((a, b) => a + b, 0);

      return {
        accounts: { ...accounts, total: sum(accounts) },
        groups: { ...groups, total: sum(groups), agentEnabled },
        messages: {
          todayInbound,
          todayOutbound,
          outboundFailed: delivery.failed,
          outboundUnknown: delivery.unknown,
          outboundQueued: delivery.queued,
        },
        agentRuns: {
          running: agentRunsRunning,
          todayFinished: agentRunsTodayFinished,
          todayFailed: agentRunsTodayFailed,
          blocked: agentRunsBlocked,
        },
        sequenceRuns: { running: sequenceRunsRunning },
        jobs: { running: jobsRunning, todayFailed: jobsTodayFailed },
        inconsistencies: { unresolved },
        dayStart: dayStart.toISOString(),
        timeZone: BUSINESS_TIME_ZONE,
        generatedAt: now.toISOString(),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
