// issue #8：入站 SSE worker —— 游标、去重（S2）、乱序 / 补投排序、自己消息回流（S3）、成员表、终态级联、
// 处理失败可见、断流重连与停机恢复。
// 真库（tests/setup.ts 的临时 schema）。ingest 一节直接喂帧（确定、快）；worker 一节用 src/sim/gateway 起在
// listen(0) 上的真 SSE（真 socket、真定时器，等待用短轮询而不是真 sleep 一段固定时间）。
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Prisma } from "../src/db/generated/client.js";
import {
  createGatewayClient,
  type GatewayEvent,
  GatewayResponseError,
  GatewayUnreachableError,
  parseSseFrame,
} from "../src/services/gateway-client.js";
import {
  advanceCursor,
  type ApplyGatewayDelivery,
  AUTO_RESOLVED_BY,
  INCONSISTENCY_KINDS,
  ingest,
  MAX_ATTEMPTS,
  ORPHAN_GRACE_MS,
  readCursor,
  RETRY_BASE_MS,
  retryDueEvents,
} from "../src/services/inbound-service.js";
import { applyGatewayDelivery } from "../src/services/outbox-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import {
  abortableSleep,
  consumeOnce,
  startInboundWorker,
} from "../src/workers/inbound-worker.js";
import {
  makeAccount,
  makeGroup,
  makeMessage,
  withFailingUpdates,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const silentLog = logger.child({}, { level: "silent" });

/** 可拨动的假时钟（业务「现在」）；SSE 等待不用它，用真定时器 + 短轮询。 */
function fakeClock(start = new Date()): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
  };
}

/** 从「现在」推导的时刻（不写死年月） */
const at = (offsetMs: number): Date => new Date(Date.now() + offsetMs);

let nextEventId = 0;
/** 造一帧；eventId 递增（可指定） */
function frame(type: string, data: Json, eventId?: number): GatewayEvent {
  const id = eventId ?? ++nextEventId;
  return { eventId: id, type, data: { ...data, eventId: id, type } };
}

/** 短轮询等待条件成立（真定时器；不真等固定时长） */
async function waitFor(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`等待超时：${what}`);
}

const db = () => getDb();
const wsEvents = (type: string) =>
  db().wsEvent.findMany({ where: { type }, orderBy: { id: "asc" } });
const inconsistencies = (kind?: string) =>
  db().inconsistency.findMany({
    where: kind ? { kind } : {},
    orderBy: { createdAt: "asc" },
  });

// ---------------------------------------------------------------------------
// SSE 帧解析（纯函数）
// ---------------------------------------------------------------------------

describe("parseSseFrame", () => {
  it("id / event / data 三帧 → 事件；多行 data 拼接；注释与未知字段忽略；\\r\\n 已由调用方归一", () => {
    const parsed = parseSseFrame(
      ': keep-alive\nid: 42\nevent: message\ndata: {"a":1,\ndata: "b":2}\nretry: 1000',
    );
    expect(parsed).toEqual({
      eventId: 42,
      type: "message",
      data: { a: 1, b: 2 },
    });
  });

  it("缺 id / event / data、id 不是整数、data 不是 JSON 对象 → undefined（跳过这一帧，不断流）", () => {
    expect(parseSseFrame("event: message\ndata: {}")).toBeUndefined();
    expect(parseSseFrame("id: 1\ndata: {}")).toBeUndefined();
    expect(parseSseFrame("id: 1\nevent: message")).toBeUndefined();
    expect(parseSseFrame("id: abc\nevent: message\ndata: {}")).toBeUndefined();
    expect(parseSseFrame("id: 1\nevent: message\ndata: [1]")).toBeUndefined();
    expect(
      parseSseFrame("id: 1\nevent: message\ndata: not-json"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ingest：直接喂帧（真库，不起网关）
// ---------------------------------------------------------------------------

describe("ingest", () => {
  const clock = fakeClock();

  beforeEach(async () => {
    await truncateAll();
    nextEventId = 0;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** 本地群 + 网关 groupId */
  async function localGroup(gatewayGroupId = "g-1") {
    return makeGroup({ gatewayGroupId });
  }

  const msgData = (
    groupId: string,
    msgId: string,
    overrides: Json = {},
  ): Json => ({
    groupId,
    msgId,
    senderPlatformUserId: "ext-1",
    text: `text-${msgId}`,
    sentAt: at(0).toISOString(),
    ...overrides,
  });

  describe("message：去重与排序", () => {
    it("S2：同一事件推两次 → 时间线一行、inbound_events 一行、ws message 事件一条；第二次 outcome = duplicate", async () => {
      const group = await localGroup();
      const ev = frame("message", msgData("g-1", "m1"));
      const first = await ingest(ev, { clock, log: silentLog });
      const second = await ingest(ev, { clock, log: silentLog });
      expect(first.outcome).toBe("processed");
      expect(second.outcome).toBe("duplicate");

      const rows = await db().message.findMany({
        where: { groupId: group.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        msgId: "m1",
        isOwn: false,
        senderPlatformUserId: "ext-1",
        text: "text-m1",
        deliveryStatus: null,
        clientMsgId: null,
      });
      const inbound = await db().inboundEvent.findMany();
      expect(inbound).toHaveLength(1);
      expect(inbound[0]?.processedAt).not.toBeNull();
      expect(inbound[0]?.groupId).toBe("g-1");
      expect(inbound[0]?.payload).toEqual(ev.data);
      expect((await wsEvents("message")).map((e) => e.payload)).toEqual([
        { groupId: group.id, msgId: "m1", isOwn: false },
      ]);
    });

    it("补投（新 eventId、同 msgId、早 sentAt）不新建行、不再发 ws 事件；乱序到达的两条按 sentAt 排", async () => {
      const group = await localGroup();
      // 先到的是晚发的（乱序）
      const late = frame(
        "message",
        msgData("g-1", "late", { sentAt: at(500).toISOString() }),
      );
      const early = frame(
        "message",
        msgData("g-1", "early", { sentAt: at(0).toISOString() }),
      );
      await ingest(late, { clock, log: silentLog });
      await ingest(early, { clock, log: silentLog });
      // 离线补投：一条几小时前的消息，新 eventId、原 msgId / sentAt
      const old = frame(
        "message",
        msgData("g-1", "old", { sentAt: at(-3 * 3600_000).toISOString() }),
      );
      await ingest(old, { clock, log: silentLog });
      const redelivered = await ingest(frame("message", old.data), {
        clock,
        log: silentLog,
      });
      expect(redelivered.outcome).toBe("processed"); // 事件是新的（新 eventId），消息不是

      const ordered = await db().message.findMany({
        where: { groupId: group.id },
        orderBy: { sentAt: "asc" },
      });
      expect(ordered.map((m) => m.msgId)).toEqual(["old", "early", "late"]);
      expect(await db().inboundEvent.count()).toBe(4);
      expect((await wsEvents("message")).map((e) => e.payload)).toEqual([
        { groupId: group.id, msgId: "late", isOwn: false },
        { groupId: group.id, msgId: "early", isOwn: false },
        { groupId: group.id, msgId: "old", isOwn: false },
      ]);
    });

    it("mediaUrl 原样存进 payload 与 media_url 列（不下载，C1 不做）", async () => {
      const group = await localGroup();
      await ingest(
        frame(
          "message",
          msgData("g-1", "m-media", { mediaUrl: "http://gw/media/abc" }),
        ),
        { clock, log: silentLog },
      );
      const row = await db().message.findUniqueOrThrow({
        where: { groupId_msgId: { groupId: group.id, msgId: "m-media" } },
      });
      expect(row.mediaUrl).toBe("http://gw/media/abc");
      const inbound = await db().inboundEvent.findFirstOrThrow();
      expect((inbound.payload as Json).mediaUrl).toBe("http://gw/media/abc");
    });

    it("本地没有的群（外部群）：不写时间线、记 inbound_unknown_group 不一致 + ws inconsistency，事件算处理完", async () => {
      const ev = frame("message", msgData("g-nowhere", "m1"));
      const result = await ingest(ev, { clock, log: silentLog });
      expect(result.outcome).toBe("processed");
      expect(await db().message.count()).toBe(0);
      const incs = await inconsistencies(INCONSISTENCY_KINDS.unknownGroup);
      expect(incs).toHaveLength(1);
      expect(incs[0]).toMatchObject({ ref: String(ev.eventId) });
      expect((incs[0]?.payload as Json).data).toEqual(ev.data);
      const ws = await wsEvents("inconsistency");
      expect(ws).toHaveLength(1);
      expect(ws[0]?.payload).toMatchObject({
        inconsistencyId: incs[0]?.id,
        kind: INCONSISTENCY_KINDS.unknownGroup,
        ref: String(ev.eventId),
      });
      const inbound = await db().inboundEvent.findFirstOrThrow();
      expect(inbound.processedAt).not.toBeNull();
    });
  });

  describe("message：自己的消息回流（S3）", () => {
    it("message_sent 先到（出站行已有 msgId）：只补 text，不新建；ws message isOwn = true 只发一次", async () => {
      const account = await makeAccount({ id: "acc-own" });
      const group = await localGroup();
      // 模拟 #7 已按 message_sent 写好 msgId 的出站行
      const outbound = await db().message.create({
        data: {
          groupId: group.id,
          msgId: "m-own",
          clientMsgId: "c-1",
          accountId: account.id,
          senderPlatformUserId: account.platformUserId ?? "",
          isOwn: true,
          text: "hello",
          sentAt: at(0),
          deliveryStatus: "sent",
        },
      });
      const echo = frame(
        "message",
        msgData("g-1", "m-own", {
          senderPlatformUserId: account.platformUserId,
          text: "hello",
        }),
      );
      const result = await ingest(echo, { clock, log: silentLog });
      expect(result.outcome).toBe("processed");
      const rows = await db().message.findMany({
        where: { groupId: group.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: outbound.id,
        isOwn: true,
        clientMsgId: "c-1",
        deliveryStatus: "sent",
      });
      expect((await wsEvents("message")).map((e) => e.payload)).toEqual([
        { groupId: group.id, msgId: "m-own", isOwn: true },
      ]);
      // 补投同一条自己的消息：不再发 ws 事件
      await ingest(frame("message", echo.data), { clock, log: silentLog });
      expect(await wsEvents("message")).toHaveLength(1);
      expect(await db().message.count()).toBe(1);
    });

    it("message 先于 message_sent 到：插入 isOwn = true 的回流行（accountId 回填、deliveryStatus 空），交给 #7 按 clientMsgId 合并", async () => {
      const account = await makeAccount({ id: "acc-own" });
      const group = await localGroup();
      const echo = frame(
        "message",
        msgData("g-1", "m-early", {
          senderPlatformUserId: account.platformUserId,
        }),
      );
      await ingest(echo, { clock, log: silentLog });
      const rows = await db().message.findMany({
        where: { groupId: group.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        msgId: "m-early",
        isOwn: true,
        accountId: account.id,
        clientMsgId: null,
        deliveryStatus: null,
        senderPlatformUserId: account.platformUserId,
      });
      expect((await wsEvents("message")).map((e) => e.payload)).toEqual([
        { groupId: group.id, msgId: "m-early", isOwn: true },
      ]);
    });
  });

  describe("message_sent / message_failed → #7 的 applyGatewayDelivery", () => {
    it("注入的记账函数按解析后的参数被调用（sentAt 为 Date；failed 带 code）", async () => {
      const calls: unknown[] = [];
      const applyGatewayDelivery: ApplyGatewayDelivery = async (_tx, input) => {
        calls.push(input);
      };
      const sentAt = at(0);
      const sent = await ingest(
        frame("message_sent", {
          clientMsgId: "c-1",
          msgId: "m-1",
          sentAt: sentAt.toISOString(),
        }),
        { clock, log: silentLog, applyGatewayDelivery },
      );
      const failed = await ingest(
        frame("message_failed", {
          clientMsgId: "c-2",
          code: "GROUP_WRITE_FORBIDDEN",
        }),
        { clock, log: silentLog, applyGatewayDelivery },
      );
      expect(sent.outcome).toBe("processed");
      expect(failed.outcome).toBe("processed");
      expect(calls).toEqual([
        { clientMsgId: "c-1", msgId: "m-1", sentAt },
        { clientMsgId: "c-2", code: "GROUP_WRITE_FORBIDDEN" },
      ]);
    });

    it("没注入记账函数：按处理失败入册（原文保留、attempts = 1、不一致可见），不抛", async () => {
      const ev = frame("message_sent", {
        clientMsgId: "c-1",
        msgId: "m-1",
        sentAt: at(0).toISOString(),
      });
      const result = await ingest(ev, { clock, log: silentLog });
      expect(result.outcome).toBe("failed");
      const row = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: String(ev.eventId) },
      });
      expect(row.processedAt).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain("applyGatewayDelivery");
      expect(
        await inconsistencies(INCONSISTENCY_KINDS.eventFailed),
      ).toHaveLength(1);
    });
  });

  describe("member_joined / member_left", () => {
    it("外部用户入群：accountId 为空、role member；服务账号入群：按 platformUserId 反查填 accountId；退群删行；ws member_changed", async () => {
      const group = await localGroup();
      const account = await makeAccount({ id: "acc-m" });
      const pu = account.platformUserId ?? "";
      await ingest(
        frame("member_joined", { groupId: "g-1", platformUserId: "ext-9" }),
        { clock, log: silentLog },
      );
      await ingest(
        frame("member_joined", { groupId: "g-1", platformUserId: pu }),
        {
          clock,
          log: silentLog,
        },
      );
      const members = await db().groupMember.findMany({
        where: { groupId: group.id },
        orderBy: { platformUserId: "asc" },
      });
      expect(members).toHaveLength(2);
      expect(members.find((m) => m.platformUserId === "ext-9")).toMatchObject({
        accountId: null,
        role: "member",
      });
      expect(members.find((m) => m.platformUserId === pu)).toMatchObject({
        accountId: account.id,
        role: "member",
      });

      // 重复的 member_joined（新 eventId）：不报错、不改 role
      await db().groupMember.update({
        where: {
          groupId_platformUserId: { groupId: group.id, platformUserId: pu },
        },
        data: { role: "admin" },
      });
      await ingest(
        frame("member_joined", { groupId: "g-1", platformUserId: pu }),
        {
          clock,
          log: silentLog,
        },
      );
      expect(
        (
          await db().groupMember.findUniqueOrThrow({
            where: {
              groupId_platformUserId: { groupId: group.id, platformUserId: pu },
            },
          })
        ).role,
      ).toBe("admin");

      await ingest(
        frame("member_left", { groupId: "g-1", platformUserId: "ext-9" }),
        { clock, log: silentLog },
      );
      // 已不在群的再 left：幂等
      const again = await ingest(
        frame("member_left", { groupId: "g-1", platformUserId: "ext-9" }),
        { clock, log: silentLog },
      );
      expect(again.outcome).toBe("processed");
      expect(
        (await db().groupMember.findMany({ where: { groupId: group.id } })).map(
          (m) => m.platformUserId,
        ),
      ).toEqual([pu]);

      expect((await wsEvents("member_changed")).map((e) => e.payload)).toEqual([
        {
          groupId: group.id,
          platformUserId: "ext-9",
          accountId: null,
          change: "joined",
        },
        {
          groupId: group.id,
          platformUserId: pu,
          accountId: account.id,
          change: "joined",
        },
        {
          groupId: group.id,
          platformUserId: pu,
          accountId: account.id,
          change: "joined",
        },
        {
          groupId: group.id,
          platformUserId: "ext-9",
          accountId: null,
          change: "left",
        },
        {
          groupId: group.id,
          platformUserId: "ext-9",
          accountId: null,
          change: "left",
        },
      ]);
    });

    it("成员事件按最后一次为准：更新的 member_left 已处理后，迟到的旧 member_joined 不把人加回来（反之亦然）", async () => {
      const group = await localGroup();
      const left = frame(
        "member_left",
        { groupId: "g-1", platformUserId: "u1" },
        11,
      );
      const staleJoin = frame(
        "member_joined",
        { groupId: "g-1", platformUserId: "u1" },
        10,
      );
      expect((await ingest(left, { clock, log: silentLog })).outcome).toBe(
        "processed",
      );
      expect((await ingest(staleJoin, { clock, log: silentLog })).outcome).toBe(
        "processed",
      );
      expect(
        await db().groupMember.count({ where: { groupId: group.id } }),
      ).toBe(0);

      const join = frame(
        "member_joined",
        { groupId: "g-1", platformUserId: "u2" },
        21,
      );
      const staleLeft = frame(
        "member_left",
        { groupId: "g-1", platformUserId: "u2" },
        20,
      );
      await ingest(join, { clock, log: silentLog });
      await ingest(staleLeft, { clock, log: silentLog });
      expect(
        (await db().groupMember.findMany({ where: { groupId: group.id } })).map(
          (m) => m.platformUserId,
        ),
      ).toEqual(["u2"]);
      // 过时的那两条不发 member_changed
      expect(await wsEvents("member_changed")).toHaveLength(2);
    });

    it("指向本地没有的群：不一致记录，不写成员表", async () => {
      await ingest(
        frame("member_joined", { groupId: "g-none", platformUserId: "ext-1" }),
        { clock, log: silentLog },
      );
      expect(await db().groupMember.count()).toBe(0);
      expect(
        await inconsistencies(INCONSISTENCY_KINDS.unknownGroup),
      ).toHaveLength(1);
    });
  });

  describe("account_status → 终态级联", () => {
    it.each(["suspended", "session_expired"] as const)(
      "%s：账号进终态、成员行被级联删除、account_terminal 事件；重复事件静默",
      async (status) => {
        const account = await makeAccount({ id: "acc-t" });
        const group = await localGroup();
        await db().groupMember.create({
          data: {
            groupId: group.id,
            platformUserId: account.platformUserId ?? "",
            accountId: account.id,
          },
        });
        const first = await ingest(
          frame("account_status", { accountId: account.id, status }),
          { clock, log: silentLog },
        );
        expect(first.outcome).toBe("processed");
        const row = await db().account.findUniqueOrThrow({
          where: { id: account.id },
        });
        expect(row.status).toBe(status);
        expect(await db().groupMember.count()).toBe(0);
        expect(await wsEvents("account_terminal")).toHaveLength(1);

        // 网关随后推的 member_left：行已被级联删掉，照常处理
        const left = await ingest(
          frame("member_left", {
            groupId: "g-1",
            platformUserId: account.platformUserId,
          }),
          { clock, log: silentLog },
        );
        expect(left.outcome).toBe("processed");

        // 网关「可能再推一条」同样的 account_status：静默，不再级联、不再发事件
        const again = await ingest(
          frame("account_status", { accountId: account.id, status }),
          { clock, log: silentLog },
        );
        expect(again.outcome).toBe("processed");
        expect(await wsEvents("account_terminal")).toHaveLength(1);
        expect(await inconsistencies()).toHaveLength(0);
      },
    );

    it("账号不存在：处理失败入册，不抛", async () => {
      const result = await ingest(
        frame("account_status", { accountId: "ghost", status: "suspended" }),
        { clock, log: silentLog },
      );
      expect(result.outcome).toBe("failed");
      expect(
        await inconsistencies(INCONSISTENCY_KINDS.eventFailed),
      ).toHaveLength(1);
    });
  });

  describe("处理失败：不中断、不丢", () => {
    it("payload 缺 groupId → 事务回滚、原文保留、attempts + 1、排重试、inconsistency + ws 事件；后续事件照常处理；重推同一事件 = 再试一次", async () => {
      const group = await localGroup();
      const bad = frame("message", {
        msgId: "m-bad",
        senderPlatformUserId: "ext-1",
        text: "x",
        sentAt: at(0).toISOString(),
      });
      const result = await ingest(bad, { clock, log: silentLog });
      expect(result.outcome).toBe("failed");

      const row = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: String(bad.eventId) },
      });
      expect(row.processedAt).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.lastError).toContain("groupId");
      expect(row.payload).toEqual(bad.data);
      expect(row.nextAttemptAt?.getTime()).toBe(
        clock.now().getTime() + RETRY_BASE_MS,
      );

      const incs = await inconsistencies(INCONSISTENCY_KINDS.eventFailed);
      expect(incs).toHaveLength(1);
      expect(incs[0]).toMatchObject({ ref: String(bad.eventId) });
      expect((incs[0]?.payload as Json).data).toEqual(bad.data);
      const ws = await wsEvents("inconsistency");
      expect(ws).toHaveLength(1);
      expect(ws[0]?.payload).toMatchObject({
        kind: INCONSISTENCY_KINDS.eventFailed,
        ref: String(bad.eventId),
      });
      expect(await db().message.count()).toBe(0);

      // 后一条正常
      const ok = await ingest(frame("message", msgData("g-1", "m-ok")), {
        clock,
        log: silentLog,
      });
      expect(ok.outcome).toBe("processed");
      expect(await db().message.count({ where: { groupId: group.id } })).toBe(
        1,
      );

      // 网关重推那条坏事件：还没处理成 → 再试一次（仍失败），attempts 2，退避翻倍，不再写第二条不一致
      const again = await ingest(bad, { clock, log: silentLog });
      expect(again.outcome).toBe("failed");
      const retried = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: String(bad.eventId) },
      });
      expect(retried.attempts).toBe(2);
      expect(retried.nextAttemptAt?.getTime()).toBe(
        clock.now().getTime() + 2 * RETRY_BASE_MS,
      );
      expect(
        await inconsistencies(INCONSISTENCY_KINDS.eventFailed),
      ).toHaveLength(1);
    });

    it("未知事件类型：只入册、算处理完、不写不一致", async () => {
      const result = await ingest(frame("something_new", { foo: 1 }), {
        clock,
        log: silentLog,
      });
      expect(result.outcome).toBe("processed");
      expect(await inconsistencies()).toHaveLength(0);
      expect(
        (await db().inboundEvent.findFirstOrThrow()).processedAt,
      ).not.toBeNull();
    });

    it("进程死在入册与处理之间（行在、未处理、attempts = 0）：重推时补处理", async () => {
      const group = await localGroup();
      const ev = frame("message", msgData("g-1", "m-crash"));
      await db().inboundEvent.create({
        data: {
          eventId: String(ev.eventId),
          type: ev.type,
          groupId: "g-1",
          payload: ev.data as Prisma.InputJsonObject,
        },
      });
      const result = await ingest(ev, { clock, log: silentLog });
      expect(result.outcome).toBe("processed");
      expect(await db().message.count({ where: { groupId: group.id } })).toBe(
        1,
      );
      expect(
        (await db().inboundEvent.findFirstOrThrow()).processedAt,
      ).not.toBeNull();
    });
  });

  describe("失败重试（retryDueEvents）", () => {
    const failingSent = () =>
      frame("message_sent", {
        clientMsgId: "c-1",
        msgId: "m-1",
        sentAt: at(0).toISOString(),
      });

    it("失败的事件到点被重试 worker 重新处理；成功后失败记录自动标为已处理（推 inconsistency_resolved）", async () => {
      const ev = failingSent();
      // 没注入记账函数 → 失败入册
      expect((await ingest(ev, { clock, log: silentLog })).outcome).toBe(
        "failed",
      );
      const calls: unknown[] = [];
      const deliver: ApplyGatewayDelivery = async (_tx, input) => {
        calls.push(input);
      };
      // 还没到点：不领
      expect(
        await retryDueEvents({
          clock,
          log: silentLog,
          applyGatewayDelivery: deliver,
        }),
      ).toEqual({ claimed: 0, processed: 0, failed: 0 });

      clock.advance(RETRY_BASE_MS);
      expect(
        await retryDueEvents({
          clock,
          log: silentLog,
          applyGatewayDelivery: deliver,
        }),
      ).toEqual({ claimed: 1, processed: 1, failed: 0 });
      expect(calls).toHaveLength(1);
      const row = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: String(ev.eventId) },
      });
      expect(row.processedAt).not.toBeNull();
      expect(row.nextAttemptAt).toBeNull();
      const [inc] = await inconsistencies(INCONSISTENCY_KINDS.eventFailed);
      expect(inc).toMatchObject({ resolvedBy: AUTO_RESOLVED_BY });
      expect(inc?.resolvedAt).not.toBeNull();
      expect(
        (await wsEvents("inconsistency_resolved")).map((e) => e.payload),
      ).toEqual([
        {
          id: inc?.id,
          resolvedAt: clock.now().toISOString(),
          resolvedBy: AUTO_RESOLVED_BY,
        },
      ]);
      // 处理过了：再到点也不会再领、不会再调一次
      clock.advance(60_000);
      expect(
        (
          await retryDueEvents({
            clock,
            log: silentLog,
            applyGatewayDelivery: deliver,
          })
        ).claimed,
      ).toBe(0);
      expect(calls).toHaveLength(1);
    });

    it("一直失败：退避翻倍，失败 MAX_ATTEMPTS 次后停止自动重试，留一条「已停止」的不一致给操作员", async () => {
      const ev = failingSent();
      await ingest(ev, { clock, log: silentLog });
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
        clock.advance(60_000);
        expect(await retryDueEvents({ clock, log: silentLog })).toEqual({
          claimed: 1,
          processed: 0,
          failed: 1,
        });
      }
      const row = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: String(ev.eventId) },
      });
      expect(row.attempts).toBe(MAX_ATTEMPTS);
      expect(row.nextAttemptAt).toBeNull();
      expect(row.processedAt).toBeNull();
      const incs = await inconsistencies(INCONSISTENCY_KINDS.eventFailed);
      expect(incs.map((i) => i.message)).toEqual([
        expect.stringContaining("将自动重试"),
        expect.stringContaining("已停止自动重试"),
      ]);
      clock.advance(3_600_000);
      expect((await retryDueEvents({ clock, log: silentLog })).claimed).toBe(0);
    });

    it("进程死在入册与处理之间（孤儿行）：网关不重推也会在宽限期后被重试 worker 接手", async () => {
      const group = await localGroup();
      const ev = frame("message", msgData("g-1", "m-orphan"));
      await db().inboundEvent.create({
        data: {
          eventId: String(ev.eventId),
          type: ev.type,
          groupId: "g-1",
          payload: ev.data as Prisma.InputJsonObject,
          receivedAt: clock.now(),
          nextAttemptAt: new Date(clock.now().getTime() + ORPHAN_GRACE_MS),
        },
      });
      expect((await retryDueEvents({ clock, log: silentLog })).claimed).toBe(0);
      clock.advance(ORPHAN_GRACE_MS);
      expect(await retryDueEvents({ clock, log: silentLog })).toEqual({
        claimed: 1,
        processed: 1,
        failed: 0,
      });
      expect(await db().message.count({ where: { groupId: group.id } })).toBe(
        1,
      );
    });

    it("message_failed 的后果（账号终态级联）中途出错：记账与后果一起回滚；重试时一并补上", async () => {
      const group = await localGroup();
      const account = await makeAccount({
        id: "acc-x",
        status: "online",
        platformUserId: "pu-x",
      });
      const outbound = await makeMessage({
        groupId: group.id,
        accountId: account.id,
        senderPlatformUserId: "pu-x",
        isOwn: true,
        clientMsgId: "c-x",
        deliveryStatus: "accepted",
      });
      const ev = frame("message_failed", {
        clientMsgId: "c-x",
        code: "ACCOUNT_SUSPENDED",
      });
      const first = await withFailingUpdates(
        "accounts",
        "NEW.status = 'suspended'",
        () => ingest(ev, { clock, log: silentLog, applyGatewayDelivery }),
      );
      expect(first.outcome).toBe("failed");
      // 一半都没生效：消息还是 accepted、账号还是 online
      expect(
        (await db().message.findUniqueOrThrow({ where: { id: outbound.id } }))
          .deliveryStatus,
      ).toBe("accepted");
      expect(
        (await db().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("online");

      clock.advance(RETRY_BASE_MS);
      expect(
        await retryDueEvents({ clock, log: silentLog, applyGatewayDelivery }),
      ).toEqual({ claimed: 1, processed: 1, failed: 0 });
      expect(
        await db().message.findUniqueOrThrow({ where: { id: outbound.id } }),
      ).toMatchObject({
        deliveryStatus: "failed",
        failCode: "ACCOUNT_SUSPENDED",
      });
      expect(
        (await db().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("suspended");
      expect(await wsEvents("account_terminal")).toHaveLength(1);
    });
  });

  describe("游标", () => {
    it("初始 null；只在 eventId 更大时推进（乱序后到的小 id 不回退）", async () => {
      expect(await readCursor()).toBeNull();
      await advanceCursor(5, { clock });
      expect(await readCursor()).toBe(5);
      await advanceCursor(3, { clock });
      expect(await readCursor()).toBe(5);
      await advanceCursor(9, { clock });
      expect(await readCursor()).toBe(9);
      expect(await db().eventCursor.count()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// openEventStream + worker：真 SSE（网关模拟器 listen(0)）
// ---------------------------------------------------------------------------

describe("openEventStream / inbound worker（真 SSE）", () => {
  let gateway: FastifyInstance;
  let baseUrl: string;
  let client: ReturnType<typeof createGatewayClient>;
  const clock = fakeClock();
  /** 停机 / 掐断后立刻重连：退避缩到 ≤ 10ms（真定时器） */
  const quickSleep = (ms: number, signal: AbortSignal) =>
    abortableSleep(Math.min(ms, 10), signal);
  let handles: { stop(): Promise<void> }[] = [];

  const sim = (url: string, payload?: Json) =>
    gateway.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
  const push = (kind: string, extra: Json) =>
    sim("/_sim/push", { kind, ...extra });

  beforeAll(async () => {
    gateway = await buildGatewayApp({ logger: false });
    baseUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
    client = createGatewayClient({ baseUrl });
  });

  beforeEach(async () => {
    await truncateAll();
    await sim("/_sim/reset");
    handles = [];
  });

  afterEach(async () => {
    // 先停 worker 再动网关：worker 还在时掐网关会让它空转重连
    await Promise.all(handles.map((h) => h.stop()));
  });

  afterAll(async () => {
    await gateway.close();
    await closeDb();
  });

  /** 网关侧建群（a1 为群主）+ 本地群，返回本地群与网关 groupId、a1 的 platformUserId */
  async function seedGroup() {
    const conn = await sim("/accounts/a1/connect");
    const ownerPu = conn.json<{ platformUserId: string }>().platformUserId;
    const created = await sim("/groups", { creatorAccountId: "a1" });
    const gatewayGroupId = created.json<{ groupId: string }>().groupId;
    const owner = await makeAccount({ id: "a1", platformUserId: ownerPu });
    const group = await makeGroup({
      gatewayGroupId,
      creatorAccountId: owner.id,
    });
    // 游标置 0：worker 首连带 since=0 回放全部，用例里 push 的时机就与连接建立无关（游标为 null 时不带 since，
    // 只收连接之后的 —— 那是首次部署的语义，不是用例要测的）
    await advanceCursor(0, { clock });
    return { group, gatewayGroupId, ownerPu };
  }

  function start(
    extra: Partial<Parameters<typeof startInboundWorker>[0]> = {},
  ) {
    const handle = startInboundWorker({
      clock,
      gateway: client,
      sleep: quickSleep,
      log: silentLog,
      ...extra,
    });
    handles.push(handle);
    return handle;
  }

  const messageCount = (groupId: string) =>
    db().message.count({ where: { groupId } });

  describe("openEventStream", () => {
    it("带 since 回放历史再接实时；网关掐断 → 抛 GatewayUnreachableError；abort → 安静结束", async () => {
      const { gatewayGroupId } = await seedGroup();
      await push("member_joined", {
        groupId: gatewayGroupId,
        platformUserId: "u1",
      });
      await push("member_joined", {
        groupId: gatewayGroupId,
        platformUserId: "u2",
      });

      const ac = new AbortController();
      const it1 = client
        .openEventStream({ since: 1, signal: ac.signal })
        [Symbol.asyncIterator]();
      const first = await it1.next();
      expect(first.value).toMatchObject({
        eventId: 2,
        type: "member_joined",
        data: { platformUserId: "u2", eventId: 2 },
      });
      await push("member_joined", {
        groupId: gatewayGroupId,
        platformUserId: "u3",
      });
      expect((await it1.next()).value).toMatchObject({ eventId: 3 });
      await sim("/_sim/streams/disconnect");
      await expect(it1.next()).rejects.toBeInstanceOf(GatewayUnreachableError);

      const it2 = client
        .openEventStream({ since: 0, signal: ac.signal })
        [Symbol.asyncIterator]();
      expect((await it2.next()).value).toMatchObject({ eventId: 1 });
      ac.abort();
      // 已缓冲的帧可能还会吐出来（worker 在每帧后自己看 signal），但一定以 done 结束而不是抛错
      let drained = 0;
      for (;;) {
        const step = await it2.next();
        if (step.done) break;
        drained += 1;
      }
      expect(drained).toBeLessThanOrEqual(2);
    });

    it("网关整体 503 → GatewayResponseError（worker 据此退避重连）", async () => {
      await sim("/_sim/scenario", { outage: { all: true } });
      const iter = client
        .openEventStream({ since: null })
        [Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toBeInstanceOf(GatewayResponseError);
    });
  });

  describe("worker", () => {
    it("S2 + 乱序：每个事件推两次、随机延迟乱序 → 时间线无重复、成员表正确、inbound_events 每事件一行、游标到最大 id", async () => {
      const { group, gatewayGroupId } = await seedGroup();
      await sim("/_sim/scenario", {
        events: { duplicates: 2, reorderWindowMs: 60 },
      });
      start();
      const n = 6;
      for (let i = 0; i < n; i++) {
        await push("message", {
          groupId: gatewayGroupId,
          senderPlatformUserId: "ext-1",
          text: `t${i}`,
        });
      }
      await push("member_joined", {
        groupId: gatewayGroupId,
        platformUserId: "ext-1",
      });
      const lastEventId = n + 1;
      await waitFor(
        async () => (await readCursor()) === lastEventId,
        "游标推进到最后一条",
      );
      // 乱序窗口内的重复投递也要全部到达并被吃掉
      await waitFor(
        async () => (await db().inboundEvent.count()) === lastEventId,
        "全部事件入册",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      expect(await messageCount(group.id)).toBe(n);
      expect(await db().inboundEvent.count()).toBe(lastEventId);
      expect(
        await db().inboundEvent.count({ where: { processedAt: null } }),
      ).toBe(0);
      expect(
        await db().groupMember.count({ where: { groupId: group.id } }),
      ).toBe(1);
      expect(await wsEvents("message")).toHaveLength(n);
      expect(await inconsistencies()).toHaveLength(0);
    });

    it("S3（经真网关）：a1 send 后回流的 message 事件 isOwn = true；同 msgId 只一行", async () => {
      const { group, gatewayGroupId, ownerPu } = await seedGroup();
      await sim("/_sim/scenario", { send: { eventDelayMs: 0 } });
      // message_sent 的记账交给 #7；这里用一个假实现按 clientMsgId 写出站行的 msgId（模拟 #7 的合并约定不在本用例范围）
      const deliveries: Json[] = [];
      start({
        applyGatewayDelivery: async (_tx, input) => {
          deliveries.push(input);
        },
      });
      const sent = await sim(`/groups/${gatewayGroupId}/send`, {
        accountId: "a1",
        clientMsgId: "c-own",
        text: "from a1",
      });
      expect(sent.statusCode).toBe(202);
      await waitFor(
        async () => (await messageCount(group.id)) === 1,
        "回流行落库",
      );
      await waitFor(
        async () => deliveries.length === 1,
        "message_sent 记账被调用",
      );
      const row = await db().message.findFirstOrThrow({
        where: { groupId: group.id },
      });
      expect(row).toMatchObject({
        isOwn: true,
        accountId: "a1",
        senderPlatformUserId: ownerPu,
        text: "from a1",
      });
      expect(deliveries[0]).toMatchObject({
        clientMsgId: "c-own",
        msgId: row.msgId,
      });
      expect((await wsEvents("message")).map((e) => e.payload)).toEqual([
        { groupId: group.id, msgId: row.msgId, isOwn: true },
      ]);
    });

    it("account_status 经网关：账号进终态 + 网关随后的 member_left 照常处理", async () => {
      const { group, gatewayGroupId, ownerPu } = await seedGroup();
      await db().groupMember.create({
        data: {
          groupId: group.id,
          platformUserId: ownerPu,
          accountId: "a1",
          role: "creator",
        },
      });
      start();
      await push("account_status", { accountId: "a1", status: "suspended" });
      await waitFor(
        async () =>
          (await db().account.findUniqueOrThrow({ where: { id: "a1" } }))
            .status === "suspended",
        "账号进终态",
      );
      // 网关推了 account_status + member_left 两条
      await waitFor(async () => (await readCursor()) === 2, "两条都处理完");
      expect(await db().groupMember.count()).toBe(0);
      expect(await wsEvents("account_terminal")).toHaveLength(1);
      expect(await inconsistencies()).toHaveLength(0);
      expect(gatewayGroupId).toBeTruthy();
    });

    it("处理失败不中断消费：坏 payload 入不一致，后续事件继续，游标照推", async () => {
      const { group, gatewayGroupId } = await seedGroup();
      start();
      await push("raw", {
        type: "message",
        data: {
          msgId: "bad",
          senderPlatformUserId: "e",
          text: "x",
          sentAt: at(0).toISOString(),
        },
      });
      await push("message", {
        groupId: gatewayGroupId,
        senderPlatformUserId: "e",
        text: "ok",
      });
      await waitFor(async () => (await readCursor()) === 2, "游标越过坏事件");
      expect(await messageCount(group.id)).toBe(1);
      const incs = await inconsistencies(INCONSISTENCY_KINDS.eventFailed);
      expect(incs).toHaveLength(1);
      expect(incs[0]?.ref).toBe("1");
      const bad = await db().inboundEvent.findUniqueOrThrow({
        where: { eventId: "1" },
      });
      expect(bad.processedAt).toBeNull();
      expect(bad.attempts).toBe(1);
    });

    it("断流后重连带 since 补拉：每帧后被掐断，全部事件仍恰好处理一次", async () => {
      const { group, gatewayGroupId } = await seedGroup();
      await sim("/_sim/scenario", { events: { disconnectAfterFrames: 1 } });
      start();
      const n = 5;
      for (let i = 0; i < n; i++) {
        await push("message", {
          groupId: gatewayGroupId,
          senderPlatformUserId: "e",
          text: `t${i}`,
        });
      }
      await waitFor(async () => (await readCursor()) === n, "补拉到最后一条");
      expect(await messageCount(group.id)).toBe(n);
      expect(await db().inboundEvent.count()).toBe(n);
      expect(await wsEvents("message")).toHaveLength(n);
    });

    it("停机期间推的事件恢复后都处理到：stop → push → start → 全部落库、不重复", async () => {
      const { group, gatewayGroupId } = await seedGroup();
      const first = start();
      await push("message", {
        groupId: gatewayGroupId,
        senderPlatformUserId: "e",
        text: "before",
      });
      await waitFor(async () => (await readCursor()) === 1, "停机前一条处理完");
      await first.stop();
      handles = [];

      for (let i = 0; i < 3; i++) {
        await push("message", {
          groupId: gatewayGroupId,
          senderPlatformUserId: "e",
          text: `down-${i}`,
        });
      }
      expect(await messageCount(group.id)).toBe(1);

      start();
      await waitFor(async () => (await readCursor()) === 4, "恢复后补拉");
      expect(await messageCount(group.id)).toBe(4);
      expect(await db().inboundEvent.count()).toBe(4);
      expect(
        (
          await db().message.findMany({
            where: { groupId: group.id },
            orderBy: { sentAt: "asc" },
          })
        ).map((m) => m.text),
      ).toEqual(["before", "down-0", "down-1", "down-2"]);
    });

    it("consumeOnce：库不可用（这里让游标写入抛错）→ 断流返回 disconnected、游标不推进；重连后从游标重拉，去重吃掉已处理的", async () => {
      const { gatewayGroupId } = await seedGroup();
      await push("message", {
        groupId: gatewayGroupId,
        senderPlatformUserId: "e",
        text: "x",
      });
      const ac = new AbortController();
      const result = await consumeOnce(
        {
          clock,
          gateway: client,
          log: silentLog,
          cursorStore: {
            read: readCursor,
            advance: async () => {
              throw new Error("db down");
            },
          },
        },
        ac.signal,
      );
      expect(result.reason).toBe("disconnected");
      expect(result.frames).toBe(1);
      expect(await readCursor()).toBe(0);
      // 下一次连接从游标 0 重拉：事件已入册且处理过 → duplicate，不重复写
      const again = start();
      await waitFor(async () => (await readCursor()) === 1, "重连后补到");
      await again.stop();
      expect(await db().inboundEvent.count()).toBe(1);
      expect(await db().message.count()).toBe(1);
    });
  });
});
