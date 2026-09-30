// issue #7：两个 worker 实例并发领取不重复（FOR UPDATE SKIP LOCKED），且同一账号同一时刻只在途一条。
// 多连接真并行：每个 claimBatch 各自一个 $transaction（交互式事务各占一条池连接），Promise.all 同时发出 ——
// 同一事务里串行是测不出互斥的。变异自检：把 claimBatch 的 SKIP LOCKED 去掉，两个副本会领到同一条（或互相阻塞）。
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/db/client.js";
import { claimBatch } from "../src/services/outbox-service.js";
import { makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

describe("outbox：并发领取", () => {
  beforeEach(truncateAll);

  afterAll(async () => {
    await closeDb();
  });

  /** 3 个账号各 3 条 queued 消息（sentAt 递增），共 9 条 */
  async function stage() {
    const db = getDb();
    const group = await makeGroup({ gatewayGroupId: `g_${randomUUID()}` });
    const accounts = await Promise.all(
      Array.from({ length: 3 }, () => makeAccount({ status: "online" })),
    );
    const base = Date.now();
    let i = 0;
    for (const account of accounts) {
      for (let k = 0; k < 3; k++) {
        await db.message.create({
          data: {
            groupId: group.id,
            accountId: account.id,
            clientMsgId: randomUUID(),
            senderPlatformUserId: account.platformUserId!,
            isOwn: true,
            text: `${account.id}-${k}`,
            sentAt: new Date(base + i++),
            deliveryStatus: "queued",
          },
        });
      }
    }
    return { accounts };
  }

  it("两个副本同时领：没有一条被领两次；每个账号至多一条在途；其余留在 queued", async () => {
    const { accounts } = await stage();
    const now = new Date();
    const [a, b] = await Promise.all([
      claimBatch("worker-a", now, 10),
      claimBatch("worker-b", now, 10),
    ]);
    const all = [...a, ...b];
    const ids = all.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 每个账号最多一条在途（两个副本合起来）
    const perAccount = new Map<string, number>();
    for (const m of all) {
      perAccount.set(m.accountId, (perAccount.get(m.accountId) ?? 0) + 1);
    }
    for (const n of perAccount.values()) expect(n).toBe(1);
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.length).toBeLessThanOrEqual(accounts.length);

    const claimed = await getDb().message.findMany({
      where: { claimedBy: { not: null } },
    });
    expect(claimed).toHaveLength(all.length);
    for (const m of claimed) {
      expect(m.attempts).toBe(1);
      expect(m.lockedAt?.getTime()).toBe(now.getTime());
    }
    // 领取标记与 outbound_attempts 一一对应
    expect(await getDb().outboundAttempt.count()).toBe(all.length);
    expect(
      await getDb().message.count({
        where: { deliveryStatus: "queued", claimedBy: null },
      }),
    ).toBe(9 - all.length);
  });

  it("多轮并发直到领完：9 条恰好各被领一次，每轮每账号至多一条", async () => {
    await stage();
    const seen = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const now = new Date();
      const batches = await Promise.all([
        claimBatch("worker-a", now, 10),
        claimBatch("worker-b", now, 10),
      ]);
      const perAccount = new Map<string, number>();
      for (const m of batches.flat()) {
        expect(seen.has(m.id)).toBe(false);
        seen.add(m.id);
        perAccount.set(m.accountId, (perAccount.get(m.accountId) ?? 0) + 1);
        // 记账：释放在途标记（模拟 accepted），让下一轮能领该账号的下一条
        await getDb().message.update({
          where: { id: m.id },
          data: { deliveryStatus: "accepted", claimedBy: null, lockedAt: null },
        });
      }
      for (const n of perAccount.values()) expect(n).toBe(1);
      if (seen.size === 9) break;
    }
    expect(seen.size).toBe(9);
  });
});
