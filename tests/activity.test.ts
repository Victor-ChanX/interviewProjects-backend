// issue #22：最近动态 GET /api/activity —— ws_events 的只读视图（白名单类型、按 seq 倒序、游标分页）。
// 真库，事件用 src/services/ws-events.ts 的 emitWsEvent 写（与业务写入方同一个入口）。
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { ActivityPage } from "../src/schemas/activity.js";
import { emitWsEvent, type WsEventType } from "../src/services/ws-events.js";
import { loginAs } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string } };

describe("GET /api/activity", () => {
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

  const list = (query: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: "/api/activity",
      query,
      headers: viewer,
    });

  const emit = async (type: WsEventType, n: number) =>
    (await emitWsEvent(getDb(), type, { n })).seq;

  it("主流程：只下发白名单类型，按 seq 倒序，payload 原样", async () => {
    const s1 = await emit("account_status_changed", 1);
    await emit("inconsistency_resolved", 2); // 操作回执，不进动态流
    const s3 = await emit("message", 3);
    const s4 = await emit("job", 4);
    await emit("inconsistency_resolved", 5);
    const s6 = await getDb().wsEvent.create({
      data: {
        type: "member_changed",
        payload: { groupId: "g", platformUserId: "pu", change: "joined" },
      },
    });

    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json<ActivityPage>();
    expect(body.items.map((e) => e.seq)).toEqual([s6.seq, s4, s3, s1]);
    expect(body.items.map((e) => e.type)).toEqual([
      "member_changed",
      "job",
      "message",
      "account_status_changed",
    ]);
    expect(body.items[0]).toEqual({
      seq: s6.seq,
      type: "member_changed",
      payload: { groupId: "g", platformUserId: "pu", change: "joined" },
      createdAt: s6.createdAt.toISOString(),
    });
    expect(body.nextCursor).toBeNull();
  });

  it("白名单覆盖：十种业务事件类型都能出现在动态里", async () => {
    const types: WsEventType[] = [
      "account_status_changed",
      "account_terminal",
      "inconsistency",
      "message",
      "agent_run",
      "sequence_run",
      "job",
      "group_status_changed",
      "group_settings_changed",
      "member_changed",
    ];
    for (const [i, t] of types.entries()) await emit(t, i);
    const body = (await list()).json<ActivityPage>();
    expect(new Set(body.items.map((e) => e.type))).toEqual(new Set(types));
  });

  it("游标：limit=2 翻完所有页不重不漏（夹着非白名单事件）；翻页途中新写的事件不挤进后面的页", async () => {
    const expected: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      expected.push(await emit("agent_run", i));
      await emit("inconsistency_resolved", i);
    }
    expected.reverse();

    const first = (await list({ limit: "2" })).json<ActivityPage>();
    expect(first.items.map((e) => e.seq)).toEqual(expected.slice(0, 2));
    // 翻页途中来了新事件：seq 更大，只会出现在第一页之前
    await emit("message", 99);

    const seen = [...first.items.map((e) => e.seq)];
    let before = first.nextCursor;
    let pages = 1;
    while (before !== null && pages < 20) {
      const page: ActivityPage = (
        await list({ limit: "2", before })
      ).json<ActivityPage>();
      seen.push(...page.items.map((e) => e.seq));
      before = page.nextCursor;
      pages += 1;
    }
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it("边界：坏游标 422 VALIDATION_ERROR；limit 越界 400；空表返回空列表；不带 token 401", async () => {
    const empty = await list();
    expect(empty.json<ActivityPage>()).toEqual({ items: [], nextCursor: null });

    const bad = await list({ before: "bm90LWEtc2Vx" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");

    const tooMany = await list({ limit: "500" });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");

    const anon = await app.inject({ method: "GET", url: "/api/activity" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
  });
});
