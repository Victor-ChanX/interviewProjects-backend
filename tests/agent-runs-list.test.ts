// issue #22：全局 agent run 列表 GET /api/agent-runs（筛选 + keyset 游标）。
// 真库，直接写 agent_runs（tests/factories.ts 的 makeAgentRun）；createdAt 从「现在」推导、毫秒精度（游标按 ISO 毫秒编码）。
// 已有的 GET /api/groups/:id/agent-runs（{ items, total }）不受影响，末尾有一条回归断言。
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import type { AgentRun, Group } from "../src/db/generated/client.js";
import type { AgentRunPage } from "../src/schemas/agent-run.js";
import { loginAs, makeAgentRun, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string } };

describe("GET /api/agent-runs", () => {
  let app: FastifyInstance;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const list = (
    query: Record<string, string> = {},
    headers: Record<string, string> = viewer,
  ) => app.inject({ method: "GET", url: "/api/agent-runs", query, headers });

  /** 翻完所有页，返回 id 序列与请求次数 */
  async function collectAll(
    query: Record<string, string>,
  ): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const res = await list({
        ...query,
        ...(before !== null ? { before } : {}),
      });
      expect(res.statusCode).toBe(200);
      const body: AgentRunPage = res.json<AgentRunPage>();
      ids.push(...body.items.map((r) => r.id));
      before = body.nextCursor;
      pages += 1;
    } while (before !== null && pages < 50);
    return { ids, pages };
  }

  /** 两个群 + 一个建群未完成（gatewayGroupId 为 null）的群，各状态造几笔；返回按 (createdAt desc, id desc) 排好的期望序列 */
  async function seed(): Promise<{
    g1: Group;
    g2: Group;
    g3: Group;
    runs: AgentRun[];
  }> {
    const g1 = await makeGroup({ gatewayGroupId: "gw-g1" });
    const g2 = await makeGroup({ gatewayGroupId: "gw-g2" });
    const g3 = await makeGroup();
    const base = Date.now();
    const at = (secAgo: number) => new Date(base - secAgo * 1000);
    const runs = [
      await makeAgentRun({
        groupId: g1.id,
        status: "running",
        createdAt: at(1),
      }),
      await makeAgentRun({
        groupId: g2.id,
        status: "finished",
        createdAt: at(2),
        summary: "已回复",
        stepCount: 3,
      }),
      await makeAgentRun({
        groupId: g1.id,
        status: "failed",
        createdAt: at(3),
      }),
      await makeAgentRun({
        groupId: g3.id,
        status: "blocked",
        createdAt: at(4),
      }),
      await makeAgentRun({
        groupId: g2.id,
        status: "finished",
        createdAt: at(5),
      }),
      await makeAgentRun({
        groupId: g1.id,
        status: "finished",
        createdAt: at(6),
      }),
    ];
    return { g1, g2, g3, runs };
  }

  it("主流程：全部群的 run 按 createdAt 倒序，列表项带 gatewayGroupId，不含 steps / triggerMessages", async () => {
    const { g1, g2, g3, runs } = await seed();
    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json<AgentRunPage>();
    expect(body.items.map((r) => r.id)).toEqual(runs.map((r) => r.id));
    expect(body.nextCursor).toBeNull();

    const second = body.items[1]!;
    expect(second).toEqual({
      id: runs[1]!.id,
      groupId: g2.id,
      gatewayGroupId: "gw-g2",
      status: "finished",
      endReason: "final",
      summary: "已回复",
      stepCount: 3,
      createdAt: runs[1]!.createdAt.toISOString(),
      finishedAt: runs[1]!.finishedAt!.toISOString(),
    });
    expect(body.items[0]).toMatchObject({
      groupId: g1.id,
      status: "running",
      endReason: null,
      finishedAt: null,
    });
    // 建群未完成的群：gatewayGroupId 为 null
    expect(body.items.find((r) => r.groupId === g3.id)?.gatewayGroupId).toBe(
      null,
    );
    expect(Object.keys(second)).not.toContain("steps");
    expect(Object.keys(second)).not.toContain("triggerMessages");
  });

  it("筛选：status、groupId 各自与组合；不存在的群返回空列表（筛选条件，不是 404）", async () => {
    const { g1, g2, runs } = await seed();
    const ids = async (q: Record<string, string>) =>
      (await list(q)).json<AgentRunPage>().items.map((r) => r.id);

    expect(await ids({ status: "finished" })).toEqual(
      [runs[1]!, runs[4]!, runs[5]!].map((r) => r.id),
    );
    expect(await ids({ groupId: g1.id })).toEqual(
      [runs[0]!, runs[2]!, runs[5]!].map((r) => r.id),
    );
    expect(await ids({ groupId: g2.id, status: "finished" })).toEqual(
      [runs[1]!, runs[4]!].map((r) => r.id),
    );
    expect(await ids({ status: "cancelled" })).toEqual([]);
    const none = await list({ groupId: "no-such-group" });
    expect(none.statusCode).toBe(200);
    expect(none.json<AgentRunPage>()).toEqual({ items: [], nextCursor: null });
  });

  it("游标：limit=2 翻完所有页不重不漏，含 createdAt 相同的行（按 id 决胜）；最后一页 nextCursor 为 null", async () => {
    const groups = await Promise.all(
      Array.from({ length: 7 }, () => makeGroup()),
    );
    const same = new Date(Date.now() - 10_000);
    const runs: AgentRun[] = [];
    // 前 4 条同一毫秒，后 3 条各自更早
    for (let i = 0; i < 7; i += 1) {
      runs.push(
        await makeAgentRun({
          groupId: groups[i]!.id,
          status: "finished",
          createdAt: i < 4 ? same : new Date(same.getTime() - (i - 3) * 1000),
        }),
      );
    }
    const expected = [...runs]
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((r) => r.id);

    const { ids, pages } = await collectAll({ limit: "2" });
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(7);
    expect(pages).toBe(4);

    // 带筛选翻页同样不重不漏
    const filtered = await collectAll({ limit: "1", status: "finished" });
    expect(filtered.ids).toEqual(expected);
  });

  it("游标：翻页途中新建的 run 不会挤进后面的页（不重复、不遗漏旧行）", async () => {
    const { runs } = await seed();
    const first = (await list({ limit: "3" })).json<AgentRunPage>();
    expect(first.items.map((r) => r.id)).toEqual(
      runs.slice(0, 3).map((r) => r.id),
    );
    const g = await makeGroup();
    await makeAgentRun({ groupId: g.id, status: "finished" });

    const second = (
      await list({ limit: "3", before: first.nextCursor! })
    ).json<AgentRunPage>();
    expect(second.items.map((r) => r.id)).toEqual(
      runs.slice(3).map((r) => r.id),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("边界：坏游标 422 VALIDATION_ERROR；非法 status / limit 越界 400 VALIDATION_ERROR；不带 token 401", async () => {
    const bad = await list({ before: "not-a-cursor" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");

    const badStatus = await list({ status: "exploded" });
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");

    const tooMany = await list({ limit: "201" });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");

    const anon = await app.inject({ method: "GET", url: "/api/agent-runs" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
  });

  it("回归：GET /api/groups/:id/agent-runs 仍是 { items, total }（该群全部 run 数）", async () => {
    const { g1 } = await seed();
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${g1.id}/agent-runs`,
      headers: viewer,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; total: number }>();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(Object.keys(body)).toEqual(["items", "total"]);
  });
});
