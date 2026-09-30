// issue #22：异常中心（题目 A2「写库失败 … 推 inconsistency 事件，让操作员看到」）。
// GET /api/inconsistencies（筛选 + 游标）、GET /api/inconsistencies/:id（带 payload）、
// POST /api/inconsistencies/:id/resolve（admin；幂等；同一事务推 ws inconsistency_resolved）。
// 真库，直接写 inconsistencies（tests/factories.ts 的 makeInconsistency）；时间从「现在」推导。
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Inconsistency } from "../src/db/generated/client.js";
import { SEED_USERS } from "../src/db/seed.js";
import type { DashboardSummary } from "../src/schemas/dashboard.js";
import type {
  InconsistencyDetail,
  InconsistencyPage,
  InconsistencyRead,
} from "../src/schemas/inconsistency.js";
import { loginAs, makeInconsistency } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string } };

const ADMIN_USERNAME = SEED_USERS.find((u) => u.role === "admin")!.username;

describe("异常中心 /api/inconsistencies", () => {
  let app: FastifyInstance;
  let viewer: Record<string, string>;
  let admin: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    viewer = await loginAs(app, "viewer");
    admin = await loginAs(app, "admin");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const list = (
    query: Record<string, string> = {},
    headers: Record<string, string> = viewer,
  ) =>
    app.inject({ method: "GET", url: "/api/inconsistencies", query, headers });

  const resolve = (id: string, headers: Record<string, string> = admin) =>
    app.inject({
      method: "POST",
      url: `/api/inconsistencies/${id}/resolve`,
      headers,
    });

  const resolvedEvents = () =>
    getDb().wsEvent.findMany({
      where: { type: "inconsistency_resolved" },
      orderBy: { id: "asc" },
    });

  /** 5 条，createdAt = 现在 − i 秒；第 2、4 条（i = 1、3）已处理。返回按插入顺序（即最新在前） */
  async function seed(): Promise<Inconsistency[]> {
    const base = Date.now();
    const rows: Inconsistency[] = [];
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(base - i * 1000);
      rows.push(
        await makeInconsistency({
          kind: i % 2 === 0 ? "inbound_event_failed" : "inbound_unknown_group",
          ref: `evt-${i}`,
          message: `m${i}`,
          createdAt: at,
          ...(i % 2 === 1 ? { resolvedAt: at, resolvedBy: "someone" } : {}),
        }),
      );
    }
    return rows;
  }

  describe("列表", () => {
    it("主流程：按 createdAt 倒序，字段齐全、不含 payload；resolved=false / true 筛选", async () => {
      const rows = await seed();
      const res = await list();
      expect(res.statusCode).toBe(200);
      const body = res.json<InconsistencyPage>();
      expect(body.items.map((r) => r.id)).toEqual(rows.map((r) => r.id));
      expect(body.nextCursor).toBeNull();
      expect(body.items[1]).toEqual({
        id: rows[1]!.id,
        kind: "inbound_unknown_group",
        ref: "evt-1",
        message: "m1",
        createdAt: rows[1]!.createdAt.toISOString(),
        resolvedAt: rows[1]!.resolvedAt!.toISOString(),
        resolvedBy: "someone",
      });
      expect(Object.keys(body.items[0]!)).not.toContain("payload");

      const open = (
        await list({ resolved: "false" })
      ).json<InconsistencyPage>();
      expect(open.items.map((r) => r.ref)).toEqual(["evt-0", "evt-2", "evt-4"]);
      expect(open.items.every((r) => r.resolvedAt === null)).toBe(true);

      const done = (await list({ resolved: "true" })).json<InconsistencyPage>();
      expect(done.items.map((r) => r.ref)).toEqual(["evt-1", "evt-3"]);
    });

    it("游标：limit=2 翻页不重不漏（带 resolved 筛选同样）；坏游标 422；resolved 非法值 400", async () => {
      const rows = await seed();
      const collect = async (q: Record<string, string>) => {
        const ids: string[] = [];
        let before: string | null = null;
        let pages = 0;
        do {
          const body: InconsistencyPage = (
            await list({ ...q, ...(before !== null ? { before } : {}) })
          ).json<InconsistencyPage>();
          ids.push(...body.items.map((r) => r.id));
          before = body.nextCursor;
          pages += 1;
        } while (before !== null && pages < 20);
        return { ids, pages };
      };
      const all = await collect({ limit: "2" });
      expect(all.ids).toEqual(rows.map((r) => r.id));
      expect(all.pages).toBe(3);
      const open = await collect({ limit: "1", resolved: "false" });
      expect(open.ids).toEqual([rows[0]!, rows[2]!, rows[4]!].map((r) => r.id));

      const bad = await list({ before: "garbage" });
      expect(bad.statusCode).toBe(422);
      expect(bad.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
      const badFilter = await list({ resolved: "maybe" });
      expect(badFilter.statusCode).toBe(400);
      expect(badFilter.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    });

    it("闸门：不带 token → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/inconsistencies",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("详情", () => {
    it("带 payload 原文；viewer 可看", async () => {
      const row = await makeInconsistency({
        payload: { eventId: 42, type: "message", data: { groupId: "gw-x" } },
      });
      const res = await app.inject({
        method: "GET",
        url: `/api/inconsistencies/${row.id}`,
        headers: viewer,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<InconsistencyDetail>();
      expect(body.id).toBe(row.id);
      expect(body.payload).toEqual({
        eventId: 42,
        type: "message",
        data: { groupId: "gw-x" },
      });
      expect(body.resolvedAt).toBeNull();
      expect(body.resolvedBy).toBeNull();
    });

    it("不存在 → 404 INCONSISTENCY_NOT_FOUND", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/inconsistencies/no-such-id",
        headers: viewer,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe("INCONSISTENCY_NOT_FOUND");
    });
  });

  describe("标记已处理", () => {
    it("主流程：admin resolve → 200，记录处理人与时刻，推一条 ws inconsistency_resolved；工作台未处理数随之减少", async () => {
      const row = await makeInconsistency();
      await makeInconsistency();
      const before = Date.now();

      const res = await resolve(row.id);
      expect(res.statusCode).toBe(200);
      const body = res.json<InconsistencyRead>();
      expect(body.id).toBe(row.id);
      expect(body.resolvedBy).toBe(ADMIN_USERNAME);
      expect(Date.parse(body.resolvedAt!)).toBeGreaterThanOrEqual(before);

      const saved = await getDb().inconsistency.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(saved.resolvedAt?.toISOString()).toBe(body.resolvedAt);
      expect(saved.resolvedBy).toBe(ADMIN_USERNAME);

      const events = await resolvedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        id: row.id,
        resolvedAt: body.resolvedAt,
        resolvedBy: ADMIN_USERNAME,
      });

      const summary = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: viewer,
      });
      expect(summary.json<DashboardSummary>().inconsistencies.unresolved).toBe(
        1,
      );
      const open = (
        await list({ resolved: "false" })
      ).json<InconsistencyPage>();
      expect(open.items.map((r) => r.id)).not.toContain(row.id);
    });

    it("幂等：重复 resolve → 200 返回原记录（resolvedAt / resolvedBy 不变），不再推 ws 事件", async () => {
      const row = await makeInconsistency();
      const first = (await resolve(row.id)).json<InconsistencyRead>();
      const again = await resolve(row.id);
      expect(again.statusCode).toBe(200);
      expect(again.json<InconsistencyRead>()).toEqual(first);
      expect(await resolvedEvents()).toHaveLength(1);
    });

    it("别人早已处理过的记录：resolve 返回 200，处理人保持原值", async () => {
      const at = new Date(Date.now() - 60_000);
      const row = await makeInconsistency({
        resolvedAt: at,
        resolvedBy: "someone",
      });
      const res = await resolve(row.id);
      expect(res.statusCode).toBe(200);
      expect(res.json<InconsistencyRead>()).toMatchObject({
        resolvedAt: at.toISOString(),
        resolvedBy: "someone",
      });
      expect(await resolvedEvents()).toHaveLength(0);
    });

    it("viewer → 403 FORBIDDEN，记录不变、不推事件", async () => {
      const row = await makeInconsistency();
      const res = await resolve(row.id, viewer);
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>().error.code).toBe("FORBIDDEN");
      const saved = await getDb().inconsistency.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(saved.resolvedAt).toBeNull();
      expect(saved.resolvedBy).toBeNull();
      expect(await resolvedEvents()).toHaveLength(0);
    });

    it("不存在 → 404 INCONSISTENCY_NOT_FOUND；不带 token → 401", async () => {
      const missing = await resolve("no-such-id");
      expect(missing.statusCode).toBe(404);
      expect(missing.json<ErrorBody>().error.code).toBe(
        "INCONSISTENCY_NOT_FOUND",
      );
      const anon = await app.inject({
        method: "POST",
        url: "/api/inconsistencies/no-such-id/resolve",
      });
      expect(anon.statusCode).toBe(401);
      expect(anon.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
    });
  });
});
