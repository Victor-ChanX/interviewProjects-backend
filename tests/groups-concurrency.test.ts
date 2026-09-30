// issue #11：两个 job worker 实例并发领取不重复（FOR UPDATE SKIP LOCKED），没到点的不领。
// 多连接真并行：每个 claimJobs 各自一个 $transaction（交互式事务各占一条池连接），Promise.all 同时发出 ——
// 同一事务里串行是测不出互斥的。
// 变异自检：把 claimJobs 的 SKIP LOCKED 去掉 —— 第一个用例仍绿（Postgres 在锁等待后重查 claimed_by IS NULL，
// 不会重复领取，只是串行），第二个用例红：别的事务锁着一行时，领取会等到交互式事务超时而不是跳过它。
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/db/client.js";
import {
  claimJobs,
  initialCreateGroupState,
} from "../src/services/group-job-service.js";
import { makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

describe("job：并发领取", () => {
  beforeEach(truncateAll);

  afterAll(async () => {
    await closeDb();
  });

  /** n 个 running 的建群 job（到点的 + 一个没到点的 + 一个已 finished 的） */
  async function stage(n: number, now: Date) {
    const db = getDb();
    const creator = await makeAccount();
    const member = await makeAccount();
    const input = {
      creatorAccountId: creator.id,
      memberAccountIds: [member.id],
    };
    const mk = (nextRunAt: Date | null, status: "running" | "finished") =>
      makeGroup({ creatorAccountId: creator.id }).then((g) =>
        db.job.create({
          data: {
            kind: "create_group",
            status,
            groupId: g.id,
            step: "create",
            input,
            state: initialCreateGroupState(input),
            nextRunAt,
          },
        }),
      );
    const due = [];
    for (let i = 0; i < n; i++)
      due.push(await mk(new Date(now.getTime() - i), "running"));
    const notDue = await mk(new Date(now.getTime() + 60_000), "running");
    const finished = await mk(null, "finished");
    return { due, notDue, finished };
  }

  it("两个副本同时领：每个 job 恰好被一个副本领到；没到点 / 已终态的不领", async () => {
    const now = new Date();
    const { due, notDue, finished } = await stage(5, now);
    const [a, b] = await Promise.all([
      claimJobs("worker-a", now, 3),
      claimJobs("worker-b", now, 3),
    ]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
    expect(new Set(ids)).toEqual(new Set(due.map((j) => j.id)));
    expect(ids).not.toContain(notDue.id);
    expect(ids).not.toContain(finished.id);

    for (const j of [...a, ...b]) {
      expect(j.attempts).toBe(1);
      expect(j.lockedAt?.getTime()).toBe(now.getTime());
    }
    const byWorker = await getDb().job.groupBy({
      by: ["claimedBy"],
      _count: { _all: true },
      where: { claimedBy: { not: null } },
    });
    expect(byWorker.map((r) => r._count._all).sort()).toEqual([2, 3]);

    // 已被领的第三个副本领不到
    const c = await claimJobs("worker-c", now, 10);
    expect(c).toEqual([]);
  });

  it("别的事务锁着某个 job 行时：跳过它领其余的，不等待（SKIP LOCKED）", async () => {
    const now = new Date();
    const { due } = await stage(3, now);
    const locked = due[0]!.id;
    await getDb().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${locked} FOR UPDATE`;
        // 另一条连接领取：锁着的那行被跳过，其余立刻领到（没有 SKIP LOCKED 这里会等到事务超时）
        const claimed = await claimJobs("worker-b", now, 10);
        expect(claimed.map((j) => j.id).sort()).toEqual(
          due
            .slice(1)
            .map((j) => j.id)
            .sort(),
        );
      },
      { timeout: 3_000 },
    );
    const row = await getDb().job.findUniqueOrThrow({ where: { id: locked } });
    expect(row.claimedBy).toBeNull();
  });
});
