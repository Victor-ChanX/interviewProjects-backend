// issue #15 / 题目 S7：同群并发两次启动序列运行，恰好一个 201、一个 409 SEQUENCE_ALREADY_RUNNING。
// 靠部分唯一索引 sequence_runs_one_running_per_group + INSERT … ON CONFLICT DO NOTHING：后到的事务在 ON CONFLICT
// 上等先到的提交，再判定为撞了。多连接真并行：每个 startRun 各自一个 $transaction（交互式事务各占一条池连接），
// Promise.allSettled 同时发出 —— 同一事务里串行是测不出互斥的。
// 变异自检：把 startRun 的 `ON CONFLICT … DO NOTHING` 去掉 → 第二个事务撞 P2002 变 500，本文件红。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { Conflict } from "../src/core/errors.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import { createSequence, startRun } from "../src/services/sequence-service.js";
import { loginAs, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

const silent = logger.child({}, { level: "silent" });

describe("序列：并发启动（S7）", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    admin = await loginAs(app, "admin");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function _stage(): Promise<{ groupId: string; sequenceId: string }> {
    const group = await makeGroup({ gatewayGroupId: `g-${randomUUID()}` });
    const { id } = await createSequence({
      name: "并发",
      steps: [{ index: 1, accountRole: "admin", text: "{a}", delaySeconds: 1 }],
    });
    return { groupId: group.id, sequenceId: id };
  }

  it("service：Promise.allSettled 两次 startRun → 恰好一个 fulfilled、一个 Conflict SEQUENCE_ALREADY_RUNNING；库里恰好一行 running", async () => {
    const { groupId, sequenceId } = await _stage();
    const input = { sequenceId, vars: { a: "x" }, stepVars: {} };
    const results = await Promise.allSettled([
      startRun(groupId, input, { log: silent }),
      startRun(groupId, input, { log: silent }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = (failed[0] as PromiseRejectedResult).reason as unknown;
    expect(err).toBeInstanceOf(Conflict);
    expect(err).toMatchObject({ code: "SEQUENCE_ALREADY_RUNNING" });

    const runs = await getDb().sequenceRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("running");
    expect(await getDb().sequenceRunStep.count()).toBe(1);
    expect(
      await getDb().wsEvent.count({ where: { type: "sequence_run" } }),
    ).toBe(1);
  });

  it("端点：两个请求同时到 → 状态码恰好是 { 201, 409 }", async () => {
    const { groupId, sequenceId } = await _stage();
    const post = () =>
      app.inject({
        method: "POST",
        url: `/api/groups/${groupId}/sequence-runs`,
        headers: admin,
        payload: { sequenceId, vars: { a: "x" } },
      });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const rejected = a.statusCode === 409 ? a : b;
    expect(rejected.json()).toMatchObject({
      error: { code: "SEQUENCE_ALREADY_RUNNING", groupId },
    });
    expect(await getDb().sequenceRun.count()).toBe(1);
  });

  it("不同群互不影响：两个群同时启动都 201", async () => {
    const first = await _stage();
    const second = await _stage();
    const results = await Promise.allSettled([
      startRun(
        first.groupId,
        { sequenceId: first.sequenceId, vars: { a: "1" }, stepVars: {} },
        { log: silent },
      ),
      startRun(
        second.groupId,
        { sequenceId: second.sequenceId, vars: { a: "2" }, stepVars: {} },
        { log: silent },
      ),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await getDb().sequenceRun.count()).toBe(2);
  });
});
