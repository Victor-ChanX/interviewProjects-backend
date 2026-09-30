// issue #6：并发变更同一账号至多一个成功（题目 A1）。多连接真并行：每个 transition 各自一个
// $transaction（交互式事务各占一条池连接），Promise.allSettled 同时发出 —— 同一事务里串行是测不出互斥的。
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../src/db/client.js";
import { transition } from "../src/services/account-service.js";
import { makeAccount } from "./factories.js";
import { truncateAll } from "./setup.js";

describe("accounts：并发 CAS", () => {
  beforeEach(truncateAll);

  afterAll(async () => {
    await closeDb();
  });

  it("两个并发 transition（同一 expectedFrom）恰好一个成功、一个 CAS_CONFLICT，终态是赢家的", async () => {
    const account = await makeAccount({ status: "online" });
    const results = await Promise.allSettled([
      transition(account.id, {
        to: "disconnected",
        expectedFrom: "online",
        source: "operator",
      }),
      transition(account.id, {
        to: "idle",
        expectedFrom: "online",
        source: "operator",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "CAS_CONFLICT", statusCode: 409 },
    });

    const winner = fulfilled[0]!.value;
    const row = await getDb().account.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(row.status).toBe(winner.account.status);
    expect(row.version).toBe(account.version + 1);
    // 只有赢家写了状态事件
    const events = await getDb().wsEvent.findMany({
      where: { type: "account_status_changed" },
    });
    expect(events.map((e) => e.payload)).toEqual([
      { accountId: account.id, from: "online", to: winner.account.status },
    ]);
  });

  it("多路并发进终态：级联恰好执行一次，其余静默", async () => {
    const account = await makeAccount({ status: "online" });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        transition(account.id, {
          to: "suspended",
          expectedFrom: "online",
          source: i % 2 === 0 ? "gateway_event" : "send_error",
        }),
      ),
    );
    // 后到的几路要么撞 CAS（读到 online 但写时已变），要么读到已是 suspended 而静默；都不算失败的第二种
    const changed = results.filter(
      (r) => r.status === "fulfilled" && r.value.changed,
    );
    expect(changed).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ code: "CAS_CONFLICT" });
      }
    }
    const terminalEvents = await getDb().wsEvent.count({
      where: { type: "account_terminal" },
    });
    expect(terminalEvents).toBe(1);
  });
});
