// 事件类表的保留期清理（后端 #57）与就绪检查。真库（tests/setup.ts 的临时 schema）；时间用「现在」往前推，不写死年月。
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  LOGIN_LOCK_MS,
  LOGIN_WINDOW_MS,
} from "../src/services/auth-service.js";
import { READY_HEARTBEAT_MAX_AGE_MS } from "../src/services/health-service.js";
import {
  INBOUND_RETENTION_MS,
  OUTBOUND_ATTEMPT_RETENTION_MS,
  purgeOldEvents,
  WS_EVENT_RETENTION_MS,
} from "../src/services/retention-service.js";
import { startRetentionWorker } from "../src/workers/retention-worker.js";
import { makeGroup, makeMessage, publishWsEvent } from "./factories.js";
import { truncateAll } from "./setup.js";

const DAY = 86_400_000;
const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

describe("保留期清理（#57）", () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await closeDb();
  });

  it("ws_events：删过期的，但 seq 最大的那行永远留着（排号器按 MAX(seq)+1 编号）", async () => {
    const now = new Date();
    const old1 = await publishWsEvent("job", { n: 1 });
    const old2 = await publishWsEvent("job", { n: 2 });
    await getDb().wsEvent.updateMany({
      where: { id: { in: [old1.id, old2.id] } },
      data: { createdAt: ago(now, WS_EVENT_RETENTION_MS + DAY) },
    });
    // 全都过期：只删掉 seq 较小的那条
    expect((await purgeOldEvents(now)).wsEvents).toBe(1);
    expect((await getDb().wsEvent.findMany()).map((e) => e.seq)).toEqual([
      old2.seq,
    ]);
    // 新事件照样接着编号，不会从 1 重来
    const fresh = await publishWsEvent("job", { n: 3 });
    expect(fresh.seq).toBe(old2.seq + 1);
    expect((await purgeOldEvents(now)).wsEvents).toBe(1);
    expect((await getDb().wsEvent.findMany()).map((e) => e.seq)).toEqual([
      fresh.seq,
    ]);
  });

  it("inbound_events：只删已处理且过期的；未处理的（待重试）与新的留着", async () => {
    const now = new Date();
    const old = ago(now, INBOUND_RETENTION_MS + DAY);
    const base = { type: "message", payload: {}, groupId: null };
    await getDb().inboundEvent.createMany({
      data: [
        { ...base, eventId: "1", receivedAt: old, processedAt: old },
        { ...base, eventId: "2", receivedAt: old, processedAt: null },
        { ...base, eventId: "3", receivedAt: now, processedAt: now },
      ],
    });
    expect((await purgeOldEvents(now)).inboundEvents).toBe(1);
    expect(
      (
        await getDb().inboundEvent.findMany({ orderBy: { eventId: "asc" } })
      ).map((e) => e.eventId),
    ).toEqual(["2", "3"]);
  });

  it("outbound_attempts：只删结束早于保留期的", async () => {
    const now = new Date();
    const group = await makeGroup();
    const msg = await makeMessage({ groupId: group.id });
    await getDb().outboundAttempt.createMany({
      data: [
        {
          messageId: msg.id,
          attemptNo: 1,
          finishedAt: ago(now, OUTBOUND_ATTEMPT_RETENTION_MS + DAY),
        },
        { messageId: msg.id, attemptNo: 2, finishedAt: now },
        { messageId: msg.id, attemptNo: 3, finishedAt: null },
      ],
    });
    expect((await purgeOldEvents(now)).outboundAttempts).toBe(1);
    expect(
      (
        await getDb().outboundAttempt.findMany({
          orderBy: { attemptNo: "asc" },
        })
      ).map((a) => a.attemptNo),
    ).toEqual([2, 3]);
  });

  it("login_throttles：窗口已过且没锁着的删；锁着的与窗口内的留着", async () => {
    const now = new Date();
    const stale = ago(now, LOGIN_WINDOW_MS + 60_000);
    await getDb().loginThrottle.createMany({
      data: [
        { username: "old", failures: 3, windowStartedAt: stale },
        {
          username: "locked",
          failures: 0,
          windowStartedAt: stale,
          lockedUntil: new Date(now.getTime() + LOGIN_LOCK_MS),
        },
        { username: "recent", failures: 2, windowStartedAt: now },
      ],
    });
    expect((await purgeOldEvents(now)).loginThrottles).toBe(1);
    expect(
      (
        await getDb().loginThrottle.findMany({ orderBy: { username: "asc" } })
      ).map((t) => t.username),
    ).toEqual(["locked", "recent"]);
  });

  it("retention worker：启动时先清一次，stop() 立即返回", async () => {
    const now = new Date();
    const old = ago(now, INBOUND_RETENTION_MS + DAY);
    await getDb().inboundEvent.create({
      data: {
        eventId: "1",
        type: "message",
        payload: {},
        receivedAt: old,
        processedAt: old,
      },
    });
    const worker = startRetentionWorker({
      clock: { now: () => now },
      intervalMs: 3_600_000,
    });
    await vi.waitFor(async () => {
      expect(await getDb().inboundEvent.count()).toBe(0);
    });
    await worker.stop();
  });

  it("每张表一次最多删一批，剩下的下一轮接着删", async () => {
    const now = new Date();
    const old = ago(now, INBOUND_RETENTION_MS + DAY);
    await getDb().inboundEvent.createMany({
      data: [1, 2, 3].map((n) => ({
        eventId: String(n),
        type: "message",
        payload: {},
        receivedAt: old,
        processedAt: old,
      })),
    });
    expect((await purgeOldEvents(now, 2)).inboundEvents).toBe(2);
    expect((await purgeOldEvents(now, 2)).inboundEvents).toBe(1);
  });
});

describe("GET /api/health/ready（#57）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  beforeEach(truncateAll);
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const ready = () => app.inject({ method: "GET", url: "/api/health/ready" });

  it("数据库可查、schema 最新、调度器心跳新鲜 → 200，各项 ok；不需要登录", async () => {
    await getDb().schedulerHeartbeat.create({
      data: { name: "sequence", beatAt: new Date() },
    });
    const res = await ready();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      checks: { database: "ok", schema: "ok", scheduler: "ok" },
    });
  });

  it("没有 worker 在跳心跳（心跳过期或从没跳过）→ 503 NOT_READY，指出是 scheduler", async () => {
    const none = await ready();
    expect(none.statusCode).toBe(503);
    expect(none.json()).toMatchObject({
      error: {
        code: "NOT_READY",
        checks: { database: "ok", schema: "ok", scheduler: "fail" },
      },
    });
    await getDb().schedulerHeartbeat.create({
      data: {
        name: "sequence",
        beatAt: new Date(Date.now() - READY_HEARTBEAT_MAX_AGE_MS - 1_000),
      },
    });
    expect((await ready()).statusCode).toBe(503);
  });

  it("探活 /api/health 不碰依赖：没有心跳也照样 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });
});
