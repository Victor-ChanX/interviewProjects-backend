// issue #22：工作台概览 GET /api/dashboard/summary。
// 真库（tests/setup.ts 的临时 schema），直接写库造各状态的数据，断言每组的精确计数。
// 「今日」按请求的 timeZone（src/core/time-zone.ts）：日期边界从「现在」推导（startOfDay），不写死年月；
// 时区判别用例直接调 service 并注入假时钟（北京时间 07:00 在 UTC 是前一天、00:30 在 UTC 仍是前一天的下午）。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { startOfDay } from "../src/core/time-zone.js";

/** 主流程用的查看者时区：东八区的零点在 UTC 是前一天 16:00，能区分「按 UTC 日」与「按查看者日」 */
const TZ = "Asia/Shanghai";
import type { Clock } from "../src/core/clock.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Prisma } from "../src/db/generated/client.js";
import type { DashboardSummary } from "../src/schemas/dashboard.js";
import { getDashboardSummary } from "../src/services/dashboard-service.js";
import {
  loginAs,
  makeAccount,
  makeAgentRun,
  makeGroup,
  makeInconsistency,
  makeMessage,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string } };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const fixedClock = (at: Date): Clock => ({ now: () => at });

/** 出站行（outbox）：clientMsgId 与 deliveryStatus 成对（库里 CHECK），failed 要 failCode */
function _outbound(
  groupId: string,
  deliveryStatus: "queued" | "accepted" | "sent" | "failed" | "unknown",
  sentAt: Date,
): Prisma.MessageUncheckedCreateInput {
  return {
    groupId,
    isOwn: true,
    clientMsgId: randomUUID(),
    deliveryStatus,
    failCode: deliveryStatus === "failed" ? "GROUP_WRITE_FORBIDDEN" : null,
    senderPlatformUserId: "pu-self",
    text: "out",
    sentAt,
  };
}

async function _makeJob(
  status: "running" | "finished" | "failed",
  finishedAt: Date | null,
): Promise<void> {
  await getDb().job.create({
    data: { kind: "create_group", status, input: {}, finishedAt },
  });
}

async function _makeSequenceRun(
  groupId: string,
  status: "running" | "finished" | "failed" | "stopped",
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
    },
  });
}

describe("GET /api/dashboard/summary", () => {
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

  const summary = (
    headers: Record<string, string> = viewer,
    query = `?timeZone=${encodeURIComponent(TZ)}`,
  ) =>
    app.inject({
      method: "GET",
      url: `/api/dashboard/summary${query}`,
      headers,
    });

  it("主流程：各状态各造几笔（含昨天的与不计入的状态），每组计数精确", async () => {
    const dayStart = startOfDay(new Date(), TZ);
    const today = new Date(dayStart.getTime() + MINUTE);
    const yesterday = new Date(dayStart.getTime() - MINUTE);

    // 账号：所有群共用一个群主（makeGroup 不给 creator 会顺手建账号，影响计数）
    const creator = await makeAccount({ status: "online" });
    await makeAccount({ status: "online" });
    await makeAccount({ status: "idle" });
    await makeAccount({
      status: "rate_limited",
      rateLimitedUntil: new Date(Date.now() + HOUR),
    });
    await makeAccount({ status: "disconnected" });
    await makeAccount({ status: "suspended" });
    await makeAccount({ status: "session_expired" });

    // 群：active ×2（一个开 Agent）、unreachable ×1、left ×1（开着 Agent 也算进 agentEnabled）
    const g1 = await makeGroup({
      creatorAccountId: creator.id,
      agentEnabled: true,
    });
    const g2 = await makeGroup({ creatorAccountId: creator.id });
    const g3 = await makeGroup({
      creatorAccountId: creator.id,
      status: "unreachable",
    });
    await makeGroup({
      creatorAccountId: creator.id,
      status: "left",
      agentEnabled: true,
    });

    // 消息：今日入站 2、昨天入站 1；今日出站 queued / failed / sent，昨天出站 unknown / failed
    await makeMessage({ groupId: g1.id, sentAt: today });
    await makeMessage({ groupId: g2.id, sentAt: today });
    await makeMessage({ groupId: g1.id, sentAt: yesterday });
    await makeMessage(_outbound(g1.id, "queued", today));
    await makeMessage(_outbound(g1.id, "failed", today));
    await makeMessage(_outbound(g2.id, "sent", today));
    await makeMessage(_outbound(g2.id, "unknown", yesterday));
    await makeMessage(_outbound(g3.id, "failed", yesterday));

    // Agent 运行：running 1；finished 今日 1 / 昨天 1；failed 今日 1 / 昨天 1；blocked 今日 1 / 昨天 1；cancelled 今日 1
    await makeAgentRun({ groupId: g1.id, status: "running" });
    await makeAgentRun({
      groupId: g2.id,
      status: "finished",
      finishedAt: today,
    });
    await makeAgentRun({
      groupId: g2.id,
      status: "finished",
      finishedAt: yesterday,
    });
    await makeAgentRun({ groupId: g2.id, status: "failed", finishedAt: today });
    await makeAgentRun({
      groupId: g3.id,
      status: "failed",
      finishedAt: yesterday,
    });
    await makeAgentRun({
      groupId: g3.id,
      status: "blocked",
      finishedAt: today,
    });
    await makeAgentRun({
      groupId: g3.id,
      status: "blocked",
      finishedAt: yesterday,
    });
    await makeAgentRun({
      groupId: g3.id,
      status: "cancelled",
      finishedAt: today,
    });

    // 序列运行：running 1、finished 1
    await _makeSequenceRun(g1.id, "running");
    await _makeSequenceRun(g2.id, "finished");

    // job：running 1；failed 今日 1 / 昨天 1；finished 今日 1
    await _makeJob("running", null);
    await _makeJob("failed", today);
    await _makeJob("failed", yesterday);
    await _makeJob("finished", today);

    // 不一致：未处理 2、已处理 1
    await makeInconsistency();
    await makeInconsistency();
    await makeInconsistency({ resolvedAt: today, resolvedBy: "admin" });

    const res = await summary();
    expect(res.statusCode).toBe(200);
    const body = res.json<DashboardSummary>();

    expect(body.accounts).toEqual({
      idle: 1,
      online: 2,
      rate_limited: 1,
      disconnected: 1,
      suspended: 1,
      session_expired: 1,
      total: 7,
    });
    expect(body.groups).toEqual({
      active: 2,
      unreachable: 1,
      left: 1,
      total: 4,
      agentEnabled: 2,
    });
    expect(body.messages).toEqual({
      todayInbound: 2,
      todayOutbound: 3,
      outboundFailed: 2,
      outboundUnknown: 1,
      outboundQueued: 1,
    });
    expect(body.agentRuns).toEqual({
      running: 1,
      todayFinished: 1,
      todayFailed: 1,
      blocked: 2,
    });
    expect(body.sequenceRuns).toEqual({ running: 1 });
    expect(body.jobs).toEqual({ running: 1, todayFailed: 1 });
    expect(body.inconsistencies).toEqual({ unresolved: 2 });
    expect(body.timeZone).toBe(TZ);
    expect(body.dayStart).toBe(dayStart.toISOString());
    expect(Date.parse(body.generatedAt)).toBeGreaterThanOrEqual(
      dayStart.getTime(),
    );
  });

  it("边界：空库全是 0（没有任何状态行时各键仍下发）", async () => {
    // loginAs 建了 users / sessions，不影响业务计数
    const res = await summary();
    expect(res.statusCode).toBe(200);
    const body = res.json<DashboardSummary>();
    expect(body.accounts).toEqual({
      idle: 0,
      online: 0,
      rate_limited: 0,
      disconnected: 0,
      suspended: 0,
      session_expired: 0,
      total: 0,
    });
    expect(body.groups).toEqual({
      active: 0,
      unreachable: 0,
      left: 0,
      total: 0,
      agentEnabled: 0,
    });
    expect(body.messages).toEqual({
      todayInbound: 0,
      todayOutbound: 0,
      outboundFailed: 0,
      outboundUnknown: 0,
      outboundQueued: 0,
    });
    expect(body.agentRuns).toEqual({
      running: 0,
      todayFinished: 0,
      todayFailed: 0,
      blocked: 0,
    });
    expect(body.sequenceRuns).toEqual({ running: 0 });
    expect(body.jobs).toEqual({ running: 0, todayFailed: 0 });
    expect(body.inconsistencies).toEqual({ unresolved: 0 });
  });

  it("闸门：不带 token → 401 UNAUTHORIZED；viewer 可读", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
    expect((await summary(viewer)).statusCode).toBe(200);
  });

  describe("今日按查看者时区的自然日（假时钟）", () => {
    it("东八区 12:00：当天 07:00 与 00:30（UTC 都还是前一天）算今日，前一天 23:30 不算", async () => {
      const dayStart = startOfDay(new Date(), TZ);
      const clock = fixedClock(new Date(dayStart.getTime() + 12 * HOUR));
      const group = await makeGroup();
      const at0030 = new Date(dayStart.getTime() + 30 * MINUTE);
      const at0700 = new Date(dayStart.getTime() + 7 * HOUR);
      const prev2330 = new Date(dayStart.getTime() - 30 * MINUTE);

      await makeMessage({ groupId: group.id, sentAt: at0030 });
      await makeMessage({ groupId: group.id, sentAt: at0700 });
      await makeMessage({ groupId: group.id, sentAt: prev2330 });
      await makeAgentRun({
        groupId: group.id,
        status: "finished",
        finishedAt: at0030,
      });
      await makeAgentRun({
        groupId: group.id,
        status: "finished",
        finishedAt: prev2330,
      });
      await _makeJob("failed", at0700);
      await _makeJob("failed", prev2330);

      const s = await getDashboardSummary({ clock, timeZone: TZ });
      expect(s.dayStart).toBe(dayStart.toISOString());
      expect(s.generatedAt).toBe(clock.now().toISOString());
      expect(s.messages.todayInbound).toBe(2);
      expect(s.agentRuns.todayFinished).toBe(1);
      expect(s.jobs.todayFailed).toBe(1);
    });

    it("东八区 03:00（UTC 还是前一天）：前一天 23:30 不算今日，当天 00:30 算", async () => {
      const dayStart = startOfDay(new Date(), TZ);
      const clock = fixedClock(new Date(dayStart.getTime() + 3 * HOUR));
      const group = await makeGroup();
      await makeMessage({
        groupId: group.id,
        sentAt: new Date(dayStart.getTime() - 30 * MINUTE),
      });
      await makeMessage({
        groupId: group.id,
        sentAt: new Date(dayStart.getTime() + 30 * MINUTE),
      });

      const s = await getDashboardSummary({ clock, timeZone: TZ });
      expect(s.messages.todayInbound).toBe(1);
    });

    it("startOfDay：结果是该时区的 00:00（Asia/Shanghai 为 UTC+8），且不晚于 now、相差不足一天", () => {
      const now = new Date();
      const start = startOfDay(now, TZ);
      expect((start.getTime() + 8 * HOUR) % (24 * HOUR)).toBe(0);
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(now.getTime() - start.getTime()).toBeLessThan(24 * HOUR);
      // 恰在零点：起点就是自己
      expect(startOfDay(start, TZ).getTime()).toBe(start.getTime());
    });

    it("同一时刻，时区不同「今日」就不同：东八区 03:00 的前一天 23:30 记录，按 UTC 算是今日", async () => {
      const dayStart = startOfDay(new Date(), TZ);
      const clock = fixedClock(new Date(dayStart.getTime() + 3 * HOUR));
      const group = await makeGroup();
      await makeMessage({
        groupId: group.id,
        sentAt: new Date(dayStart.getTime() - 30 * MINUTE),
      });

      const shanghai = await getDashboardSummary({ clock, timeZone: TZ });
      const utc = await getDashboardSummary({ clock, timeZone: "UTC" });
      expect(shanghai.messages.todayInbound).toBe(0);
      expect(utc.messages.todayInbound).toBe(1);
      expect(utc.dayStart).toBe(startOfDay(clock.now(), "UTC").toISOString());
      expect(utc.timeZone).toBe("UTC");
    });
  });

  describe("timeZone 参数", () => {
    it("不传：按 UTC，响应回显 UTC", async () => {
      const res = await summary(viewer, "");
      expect(res.statusCode).toBe(200);
      const body = res.json<DashboardSummary>();
      expect(body.timeZone).toBe("UTC");
      expect(new Date(body.dayStart).getUTCHours()).toBe(0);
    });

    it("有夏令时的时区：dayStart 是当地 00:00，响应回显该时区", async () => {
      const res = await summary(viewer, "?timeZone=America%2FNew_York");
      expect(res.statusCode).toBe(200);
      const body = res.json<DashboardSummary>();
      expect(body.timeZone).toBe("America/New_York");
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(body.dayStart));
      expect(local).toBe("00:00");
    });

    it("不是合法时区名：400 VALIDATION_ERROR", async () => {
      const res = await summary(viewer, "?timeZone=Mars%2FOlympus");
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    });
  });
});
