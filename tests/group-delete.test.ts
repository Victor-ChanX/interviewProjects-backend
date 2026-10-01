// 删除已退出的群（#62，题目之外的控制台补充）：DELETE /api/groups/:id。真库；造数走 tests/factories.ts。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import { loginAs, makeAgentRun, makeGroup, makeMessage } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string } };

async function makeSequenceRun(
  groupId: string,
  status: "running" | "finished",
): Promise<void> {
  const db = getDb();
  const sequence = await db.sequence.create({
    data: { name: `seq-${randomUUID().slice(0, 6)}`, steps: [] },
  });
  await db.sequenceRun.create({
    data: {
      sequenceId: sequence.id,
      groupId,
      status,
      vars: {},
      stepVars: {},
      ...(status === "finished" ? { finishedAt: new Date() } : {}),
    },
  });
}

describe("DELETE /api/groups/:id（#62）", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  beforeEach(async () => {
    await truncateAll();
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const del = (id: string, headers: Record<string, string> = admin) =>
    app.inject({ method: "DELETE", url: `/api/groups/${id}`, headers });

  it("已退出的群：连同消息、agent run、序列运行、job 一起删掉；别的群不受影响", async () => {
    const left = await makeGroup({ status: "left" });
    const other = await makeGroup();
    await makeMessage({ groupId: left.id });
    await makeMessage({ groupId: left.id });
    await makeMessage({ groupId: other.id });
    await makeAgentRun({ groupId: left.id, status: "finished" });
    await makeSequenceRun(left.id, "finished");
    await getDb().job.create({
      data: {
        kind: "leave_all",
        status: "finished",
        input: {},
        groupId: left.id,
        finishedAt: new Date(),
      },
    });

    const res = await del(left.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: left.id,
      messagesDeleted: 2,
      agentRunsDeleted: 1,
      sequenceRunsDeleted: 1,
    });
    const db = getDb();
    expect(await db.group.findUnique({ where: { id: left.id } })).toBeNull();
    expect(await db.message.count({ where: { groupId: left.id } })).toBe(0);
    expect(await db.job.count({ where: { groupId: left.id } })).toBe(0);
    expect(await db.message.count({ where: { groupId: other.id } })).toBe(1);

    const again = await del(left.id);
    expect(again.statusCode).toBe(404);
    expect(again.json<ErrorBody>().error.code).toBe("GROUP_NOT_FOUND");
  });

  it("没退出的群 → 409 GROUP_NOT_LEFT；什么都不删", async () => {
    const active = await makeGroup();
    await makeMessage({ groupId: active.id });
    const res = await del(active.id);
    expect(res.statusCode).toBe(409);
    expect(res.json<ErrorBody>().error.code).toBe("GROUP_NOT_LEFT");
    expect(await getDb().message.count()).toBe(1);
  });

  it("还有进行中的 agent run / 序列运行 → 409 GROUP_BUSY", async () => {
    const withRun = await makeGroup({ status: "left" });
    await makeAgentRun({ groupId: withRun.id, status: "running" });
    const r1 = await del(withRun.id);
    expect(r1.statusCode).toBe(409);
    expect(r1.json<ErrorBody>().error.code).toBe("GROUP_BUSY");

    const withSeq = await makeGroup({ status: "left" });
    await makeSequenceRun(withSeq.id, "running");
    const r2 = await del(withSeq.id);
    expect(r2.json<ErrorBody>().error.code).toBe("GROUP_BUSY");
    expect(await getDb().group.count()).toBe(2);
  });

  it("闸门：viewer 403，不带 token 401", async () => {
    const left = await makeGroup({ status: "left" });
    expect((await del(left.id, viewer)).statusCode).toBe(403);
    expect((await del(left.id, {})).statusCode).toBe(401);
    expect(await getDb().group.count()).toBe(1);
  });
});
