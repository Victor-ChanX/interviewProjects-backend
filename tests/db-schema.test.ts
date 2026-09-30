// issue #4：数据模型的库级约束与种子。跑在真实 PostgreSQL 的临时 schema 上（tests/setup.ts 前滚整条迁移链），
// 所以这里断言的是 migration.sql 里手写的部分唯一索引 / CHECK 真的生效，不是 Prisma 类型层面的东西。
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyPassword } from "../src/core/password.js";
import { closeDb, getDb } from "../src/db/client.js";
import { Prisma } from "../src/db/generated/client.js";
import { SEED_ACCOUNT_IDS, SEED_USERS, seedDatabase } from "../src/db/seed.js";
import { makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

const silentLog = {
  info: () => undefined,
} as unknown as Parameters<typeof seedDatabase>[1];

/** 唯一冲突（含部分唯一索引撞出来的）在 Prisma 里都是 P2002。 */
async function expectUniqueViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy(
    (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002",
  );
}

describe("db schema 约束", () => {
  beforeEach(truncateAll);

  afterAll(async () => {
    await closeDb();
  });

  it("agent_runs：同群至多一个 running（部分唯一索引），结束后可再开", async () => {
    const db = getDb();
    const group = await makeGroup();
    const first = await db.agentRun.create({
      data: { groupId: group.id, triggerMessages: [] },
    });
    await expectUniqueViolation(
      db.agentRun.create({ data: { groupId: group.id, triggerMessages: [] } }),
    );
    // 别的群不受影响
    const other = await makeGroup();
    await db.agentRun.create({
      data: { groupId: other.id, triggerMessages: [] },
    });

    await db.agentRun.update({
      where: { id: first.id },
      data: { status: "finished", endReason: "final" },
    });
    await db.agentRun.create({
      data: { groupId: group.id, triggerMessages: [] },
    });
    expect(await db.agentRun.count({ where: { groupId: group.id } })).toBe(2);
  });

  it("agent_runs：并发两次创建恰好一个成功", async () => {
    const db = getDb();
    const group = await makeGroup();
    const results = await Promise.allSettled([
      db.agentRun.create({ data: { groupId: group.id, triggerMessages: [] } }),
      db.agentRun.create({ data: { groupId: group.id, triggerMessages: [] } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(
      (rejected?.reason as Prisma.PrismaClientKnownRequestError).code,
    ).toBe("P2002");
  });

  it("agent_runs：status 与 endReason 不匹配被 CHECK 拒绝", async () => {
    const db = getDb();
    const group = await makeGroup();
    const run = await db.agentRun.create({
      data: { groupId: group.id, triggerMessages: [] },
    });
    // finished 必须配 final；running 不能带 endReason
    await expect(
      db.agentRun.update({
        where: { id: run.id },
        data: { status: "finished", endReason: "cancelled" },
      }),
    ).rejects.toThrow(/agent_runs_end_reason_matches_status/);
    await expect(
      db.agentRun.update({
        where: { id: run.id },
        data: { endReason: "final" },
      }),
    ).rejects.toThrow(/agent_runs_end_reason_matches_status/);
  });

  it("sequence_runs：同群至多一个 running（部分唯一索引）", async () => {
    const db = getDb();
    const group = await makeGroup();
    const sequence = await db.sequence.create({
      data: { name: "s", steps: [] },
    });
    const data = {
      sequenceId: sequence.id,
      groupId: group.id,
      vars: {},
      stepVars: {},
    };
    const first = await db.sequenceRun.create({ data });
    await expectUniqueViolation(db.sequenceRun.create({ data }));
    await db.sequenceRun.update({
      where: { id: first.id },
      data: { status: "stopped" },
    });
    await db.sequenceRun.create({ data });
  });

  it("messages：(groupId, msgId) 唯一；msgId 为空的出站行互不冲突", async () => {
    const db = getDb();
    const group = await makeGroup();
    const base = {
      groupId: group.id,
      senderPlatformUserId: "pu-x",
      text: "hi",
      sentAt: new Date(),
    };
    await db.message.create({ data: { ...base, msgId: "m1" } });
    await expectUniqueViolation(
      db.message.create({ data: { ...base, msgId: "m1", text: "dup" } }),
    );
    // 另一个群同 msgId 可以
    const other = await makeGroup();
    await db.message.create({
      data: { ...base, groupId: other.id, msgId: "m1" },
    });

    // 两条尚未发出的出站行：msgId 都是 null，不撞
    const outbound = (clientMsgId: string) => ({
      ...base,
      isOwn: true,
      clientMsgId,
      deliveryStatus: "queued" as const,
    });
    await db.message.create({ data: outbound(randomUUID()) });
    await db.message.create({ data: outbound(randomUUID()) });
    expect(await db.message.count({ where: { groupId: group.id } })).toBe(3);
  });

  it("messages：clientMsgId 唯一；failed 必须带 failCode；出站字段成对", async () => {
    const db = getDb();
    const group = await makeGroup();
    const clientMsgId = randomUUID();
    const base = {
      groupId: group.id,
      senderPlatformUserId: "pu-x",
      text: "hi",
      sentAt: new Date(),
      isOwn: true,
    };
    const row = await db.message.create({
      data: { ...base, clientMsgId, deliveryStatus: "queued" },
    });
    await expectUniqueViolation(
      db.message.create({
        data: { ...base, clientMsgId, deliveryStatus: "queued" },
      }),
    );
    await expect(
      db.message.update({
        where: { id: row.id },
        data: { deliveryStatus: "failed" },
      }),
    ).rejects.toThrow(/messages_fail_code_when_failed/);
    await db.message.update({
      where: { id: row.id },
      data: { deliveryStatus: "failed", failCode: "ACCOUNT_OFFLINE" },
    });
    await expect(
      db.message.create({ data: { ...base, clientMsgId: randomUUID() } }),
    ).rejects.toThrow(/messages_outbound_fields_paired/);
    await expect(
      db.message.update({
        where: { id: row.id },
        data: { resendCount: 2 },
      }),
    ).rejects.toThrow(/messages_resend_at_most_once/);
  });

  it("inbound_events：eventId 唯一；event_cursor 只有一行", async () => {
    const db = getDb();
    await db.inboundEvent.create({
      data: { eventId: "e1", type: "message", payload: {} },
    });
    await expectUniqueViolation(
      db.inboundEvent.create({
        data: { eventId: "e1", type: "message", payload: {} },
      }),
    );
    await db.eventCursor.create({ data: { lastEventId: "e1" } });
    await expect(
      db.eventCursor.create({ data: { id: 2, lastEventId: "e2" } }),
    ).rejects.toThrow(/event_cursor_single_row/);
  });

  it("agent_steps：isError 必须带 errorCode；protocol_error 步不得带工具字段", async () => {
    const db = getDb();
    const group = await makeGroup();
    const run = await db.agentRun.create({
      data: { groupId: group.id, triggerMessages: [] },
    });
    await expect(
      db.agentStep.create({
        data: { runId: run.id, index: 1, kind: "tool_use", isError: true },
      }),
    ).rejects.toThrow(/agent_steps_error_code_when_error/);
    await expect(
      db.agentStep.create({
        data: {
          runId: run.id,
          index: 1,
          kind: "protocol_error",
          toolUseId: "tu_1",
        },
      }),
    ).rejects.toThrow(/agent_steps_protocol_error_fields_null/);
    await db.agentStep.create({
      data: {
        runId: run.id,
        index: 1,
        kind: "protocol_error",
        isError: true,
        errorCode: "BAD_JSON",
        rawResponse: "not json",
      },
    });
    // 同 run 内 tool_use.id 唯一
    await db.agentStep.create({
      data: { runId: run.id, index: 2, kind: "tool_use", toolUseId: "tu_1" },
    });
    await expectUniqueViolation(
      db.agentStep.create({
        data: { runId: run.id, index: 3, kind: "tool_use", toolUseId: "tu_1" },
      }),
    );
  });

  it("accounts：rate_limited 必须带 rateLimitedUntil", async () => {
    const db = getDb();
    const account = await makeAccount();
    await expect(
      db.account.update({
        where: { id: account.id },
        data: { status: "rate_limited" },
      }),
    ).rejects.toThrow(/accounts_rate_limited_has_until/);
    await db.account.update({
      where: { id: account.id },
      data: { status: "rate_limited", rateLimitedUntil: new Date() },
    });
  });
});

describe("种子", () => {
  beforeEach(truncateAll);

  afterAll(async () => {
    await closeDb();
  });

  it("跑两次不重复，且不覆盖已存在行的运行态", async () => {
    const db = getDb();
    const first = await seedDatabase(db, silentLog);
    expect(first).toEqual({
      accountsCreated: SEED_ACCOUNT_IDS.length,
      usersCreated: SEED_USERS.length,
    });
    const accounts = await db.account.findMany({ orderBy: { id: "asc" } });
    expect(accounts.map((a) => a.id)).toEqual([...SEED_ACCOUNT_IDS]);
    expect(
      accounts.every((a) => a.status === "idle" && a.platformUserId === null),
    ).toBe(true);

    // 模拟运行态变化后再跑种子：不能被打回 idle
    const [acc] = SEED_ACCOUNT_IDS;
    await db.account.update({
      where: { id: acc },
      data: { status: "online", platformUserId: "pu-1", version: 3 },
    });
    const second = await seedDatabase(db, silentLog);
    expect(second).toEqual({ accountsCreated: 0, usersCreated: 0 });
    expect(await db.account.count()).toBe(SEED_ACCOUNT_IDS.length);
    expect(await db.user.count()).toBe(SEED_USERS.length);
    const kept = await db.account.findUniqueOrThrow({ where: { id: acc } });
    expect(kept).toMatchObject({
      status: "online",
      platformUserId: "pu-1",
      version: 3,
    });
  });

  it("预置用户 admin/admin、viewer/viewer 的口令哈希可校验，且角色正确", async () => {
    const db = getDb();
    await seedDatabase(db, silentLog);
    for (const seed of SEED_USERS) {
      const user = await db.user.findUniqueOrThrow({
        where: { username: seed.username },
      });
      expect(user.role).toBe(seed.role);
      expect(user.passwordHash).not.toContain(seed.password);
      expect(await verifyPassword(seed.password, user.passwordHash)).toBe(true);
      expect(await verifyPassword("wrong", user.passwordHash)).toBe(false);
    }
    expect(await verifyPassword("admin", "garbage")).toBe(false);
  });
});
