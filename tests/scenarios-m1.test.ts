// issue #10：题目 2.4 典型场景 S1–S4 各一条端到端集成测试。
//
// 与 tests/outbox.test.ts 的区别：那里 message_sent / message_failed 是手动调 applyGatewayDelivery 模拟的；
// 这里把出站 tick 与入站 consumeOnce 真正串起来 —— 消息经 POST /api/groups/:id/send 入队 → runOutboxTick 调网关
// 模拟器 → 模拟器按场景推 SSE 事件 → consumeOnce（入站 worker 的一次连接）消费 → ingest → applyGatewayDelivery
// 记账，与 src/main.ts 的接法一致。断言同时看库、看 API 读模型、看网关 /_sim/state 的 sendCalls / messages。
//
// 真库（tests/setup.ts 的临时 schema）；网关 src/sim/gateway 起在 listen(0)；应用、worker、模拟器共用一个假 Clock，
// 限流到期靠 clock.advance；只有「等 SSE 建连」「等模拟器 setTimeout(0) 落地」用短轮询。
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

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Account, Group } from "../src/db/generated/client.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { advanceCursor, readCursor } from "../src/services/inbound-service.js";
import { applyGatewayDelivery } from "../src/services/outbox-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { consumeOnce } from "../src/workers/inbound-worker.js";
import { runOutboxTick } from "../src/workers/outbox-worker.js";
import { startRateLimitWorker } from "../src/workers/rate-limit-worker.js";
import {
  loginAs,
  makeAccount,
  makeGroup,
  stopAfterFrames,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const silent = logger.child({}, { level: "silent" });

function fakeClock(): Clock & { advance(ms: number): void; reset(): void } {
  let now = Date.now();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
    reset() {
      now = Date.now();
    },
  };
}

/** 短轮询等条件成立（真定时器；不等固定时长） */
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

type SimState = {
  sendCalls: { accountId: string; clientMsgId: string; status: number }[];
  messages: {
    msgId: string;
    clientMsgId: string | null;
    sentAt: string;
    text: string;
  }[];
  accounts: { accountId: string; rateLimitedUntil: string | null }[];
  events: { lastEventId: number; byType: Record<string, number> };
  streams: { open: number };
};

type MessageItem = {
  msgId: string | null;
  clientMsgId: string | null;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: string | null;
};

describe("典型场景 S1–S4（#10，出站 tick + 入站 consumeOnce 串联）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let stoppers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    gateway = await buildGatewayApp({ logger: false, clock });
    const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
    gatewayClient = createGatewayClient({ baseUrl: url });
    app = await buildApp({ logger: false, gateway: gatewayClient });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    clock.reset();
    stoppers = [];
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    // 202 立刻回、事件立刻推；「之前 / 之后」由入站 worker 什么时候消费决定
    await scenario({ send: { acceptDelayMs: 0, eventDelayMs: 0 } });
    await advanceCursor(0, { clock });
    admin = await loginAs(app, "admin");
  });

  afterEach(async () => {
    await Promise.all(stoppers.map((stop) => stop()));
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
    await closeDb();
  });

  // ---- 辅助 ------------------------------------------------------------------------

  const scenario = (patch: Json) =>
    gateway.inject({ method: "POST", url: "/_sim/scenario", payload: patch });
  const simState = async (): Promise<SimState> =>
    (await gateway.inject({ method: "GET", url: "/_sim/state" })).json();
  const push = async (payload: Json): Promise<number[]> => {
    const res = await gateway.inject({
      method: "POST",
      url: "/_sim/push",
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ eventIds: number[] }>().eventIds;
  };

  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  async function stageGroup(): Promise<{ group: Group; creator: Account }> {
    const creatorId = `acc-${Math.random().toString(36).slice(2, 10)}`;
    const platformUserId = await connectAtGateway(creatorId);
    const creator = await makeAccount({
      id: creatorId,
      status: "online",
      platformUserId,
    });
    const created = await gateway.inject({
      method: "POST",
      url: "/groups",
      payload: { creatorAccountId: creatorId },
    });
    expect(created.statusCode).toBe(200);
    const { groupId } = created.json<{ groupId: string }>();
    const group = await makeGroup({
      creatorAccountId: creatorId,
      gatewayGroupId: groupId,
    });
    await getDb().groupMember.create({
      data: {
        groupId: group.id,
        platformUserId,
        accountId: creatorId,
        role: "creator",
      },
    });
    return { group, creator };
  }

  async function addMember(group: Group): Promise<Account> {
    const id = `acc-${Math.random().toString(36).slice(2, 10)}`;
    const platformUserId = await connectAtGateway(id);
    const account = await makeAccount({ id, status: "online", platformUserId });
    await push({
      kind: "member_joined",
      groupId: group.gatewayGroupId,
      platformUserId,
    });
    await getDb().groupMember.create({
      data: {
        groupId: group.id,
        platformUserId,
        accountId: id,
        role: "member",
      },
    });
    return account;
  }

  /** 经 API 入队：POST /api/groups/:id/send → 202 { clientMsgId } */
  async function sendViaApi(
    group: Group,
    account: Account,
    text: string,
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/send`,
      headers: admin,
      payload: { accountId: account.id, text },
    });
    expect(res.statusCode).toBe(202);
    return res.json<{ clientMsgId: string }>().clientMsgId;
  }

  const tick = () =>
    runOutboxTick({
      clock,
      gateway: gatewayClient,
      workerId: "w1",
      log: silent,
    });

  const rowByClientMsgId = (clientMsgId: string) =>
    getDb().message.findUniqueOrThrow({ where: { clientMsgId } });

  async function timeline(group: Group): Promise<MessageItem[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/groups/${group.id}/messages`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ items: MessageItem[] }>().items;
  }

  const wsMessageEvents = async () =>
    (
      await getDb().wsEvent.findMany({
        where: { type: "message" },
        orderBy: { id: "asc" },
      })
    ).map((e) => e.payload as Json);

  /**
   * 入站 worker 的一次连接（真 SSE）：从库里的游标起消费，每处理完一帧判 stop，为真就停（factories.stopAfterFrames）。
   * 记账注入 outbox-service.applyGatewayDelivery（与 src/main.ts 相同）。返回收到的帧数。
   */
  async function consume(
    stop: (processed: number, eventId: number) => boolean,
  ): Promise<number> {
    const ac = new AbortController();
    stoppers.push(async () => ac.abort());
    const result = await consumeOnce(
      {
        clock,
        gateway: stopAfterFrames(gatewayClient, stop, ac),
        log: silent,
        applyGatewayDelivery,
      },
      ac.signal,
    );
    expect(result.reason).toBe("aborted");
    return result.frames;
  }

  /** 消费到网关当前最后一条事件（含）为止 */
  async function consumeToLatest(): Promise<number> {
    const target = (await simState()).events.lastEventId;
    return consume((_n, eventId) => eventId >= target);
  }

  // ---- S1 ------------------------------------------------------------------------------

  it("S1 受理与发出：202 → accepted（message_sent 之前）→ 入站 worker 收到 message_sent → sent；网关恰好一条", async () => {
    const { group, creator } = await stageGroup();
    const clientMsgId = await sendViaApi(group, creator, "s1");
    // 202 只保证落库：网关还没收到，时间线里已经有这条（queued）
    expect((await simState()).sendCalls).toHaveLength(0);
    expect(await rowByClientMsgId(clientMsgId)).toMatchObject({
      deliveryStatus: "queued",
      isOwn: true,
    });

    const s = await tick();
    expect(s.claimed).toBe(1);
    expect(s.outcomes.accepted).toBe(1);
    // message_sent 还没被消费：accepted（摘掉 recordAccepted，这里会停在 queued）
    const accepted = await rowByClientMsgId(clientMsgId);
    expect(accepted).toMatchObject({
      deliveryStatus: "accepted",
      msgId: null,
      claimedBy: null,
    });
    expect(accepted.acceptedAt?.getTime()).toBe(clock.now().getTime());
    expect((await timeline(group)).map((m) => m.deliveryStatus)).toEqual([
      "accepted",
    ]);
    await waitFor(
      async () => (await simState()).messages.length === 1,
      "网关侧落地并推 message_sent",
    );

    // 入站 worker 消费：message_sent → sent（msgId / sentAt 改为网关的值）；回流的 message 合并进出站行
    const frames = await consumeToLatest();
    expect(frames).toBe(2); // message_sent + 回流 message
    const landed = (await simState()).messages[0]!;
    const sent = await rowByClientMsgId(clientMsgId);
    expect(sent).toMatchObject({
      deliveryStatus: "sent",
      msgId: landed.msgId,
      failCode: null,
      isOwn: true,
    });
    expect(sent.sentAt.toISOString()).toBe(landed.sentAt);
    expect(await getDb().message.count()).toBe(1);
    expect(await timeline(group)).toEqual([
      expect.objectContaining({
        clientMsgId,
        msgId: landed.msgId,
        isOwn: true,
        deliveryStatus: "sent",
        text: "s1",
      }),
    ]);
    // 状态变化每步一条 ws 事件（前端据此把「发送中 → 已受理 → 已发出」画出来）
    expect(
      (await wsMessageEvents())
        .filter((e) => e.clientMsgId === clientMsgId)
        .map((e) => e.deliveryStatus),
    ).toEqual(["queued", "accepted", "sent"]);
    const sim = await simState();
    expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
      [clientMsgId, 202],
    ]);
    expect(sim.messages).toHaveLength(1);
  });

  // ---- S2 ------------------------------------------------------------------------------

  it("S2 事件重复：每个事件推两次（+ 离线补投）→ 时间线无重复行、每条消息恰好一条 ws 事件（agent 不被重复触发）", async () => {
    const { group, creator } = await stageGroup();
    // 每个事件推两次（重复 = 同 eventId 再来一次）；live 流才有重复，since 回放每条只回一次，所以先建连再制造事件
    await scenario({ events: { duplicates: 2 } });
    const replayed = (await simState()).events.lastEventId;
    // 新事件：message_sent + 回流 message（自己的一条）、外部消息、外部用户入群、外部消息的补投 = 5 个事件 × 2
    const newEvents = 5;
    const expectedFrames = replayed + newEvents * 2;
    const pump = consume((n) => n >= expectedFrames);
    await waitFor(
      async () => (await simState()).streams.open === 1,
      "SSE 建连",
    );

    const clientMsgId = await sendViaApi(group, creator, "own");
    await tick();
    clock.advance(1); // 外部消息的 sentAt 晚于自己的那条，时间线顺序才是确定的
    const [extEventId] = await push({
      kind: "message",
      groupId: group.gatewayGroupId,
      senderPlatformUserId: "ext-1",
      text: "hello",
    });
    await push({
      kind: "member_joined",
      groupId: group.gatewayGroupId,
      platformUserId: "ext-1",
    });
    await waitFor(
      async () => (await simState()).messages.length === 2,
      "自己的消息在网关落地",
    );
    const ext = (await simState()).messages.find((m) => m.text === "hello")!;
    // 离线补投：同一条外部消息带新 eventId 再推一次（消息级去重，与事件级去重是两回事）
    await push({ kind: "redeliver", msgId: ext.msgId });

    expect(await pump).toBe(expectedFrames);
    expect(await readCursor()).toBe((await simState()).events.lastEventId);

    // 事件级：inbound_events 每个 eventId 一行（摘掉 eventId 唯一 / P2002 分支，重复那次会再处理一遍）
    const lastEventId = (await simState()).events.lastEventId;
    expect(await getDb().inboundEvent.count()).toBe(lastEventId);
    expect(
      await getDb().inboundEvent.count({ where: { processedAt: null } }),
    ).toBe(0);
    expect(extEventId).toBeGreaterThan(replayed);
    // 消息级：时间线两行（自己的 + 外部的），补投没有第三行（摘掉 (groupId, msgId) 唯一 / skipDuplicates 就多一行）
    const items = await timeline(group);
    expect(items.map((m) => [m.text, m.isOwn])).toEqual([
      ["hello", false],
      ["own", true],
    ]);
    expect(await getDb().message.count()).toBe(2);
    // 成员表：ext-1 一行
    expect(
      await getDb().groupMember.count({ where: { groupId: group.id } }),
    ).toBe(2);
    // agent 触发点是 ws_events 里 isOwn = false 的 message 事件：恰好一条
    const events = await wsMessageEvents();
    expect(events.filter((e) => e.isOwn === false)).toHaveLength(1);
    expect(
      events
        .filter((e) => e.clientMsgId === clientMsgId)
        .map((e) => e.deliveryStatus),
    ).toEqual(["queued", "accepted", "sent"]);
    expect(await getDb().inconsistency.count()).toBe(0);
    // 出站没有因为事件重复而多发
    const sim = await simState();
    expect(sim.sendCalls).toHaveLength(1);
    expect(sim.events.byType).toMatchObject({
      message_sent: 1,
      message: 3,
      member_joined: 1,
    });
  });

  // ---- S3 ------------------------------------------------------------------------------

  it("S3 自己的消息回流：message 事件推回来 → isOwn = true、不产生新行、不产生 isOwn = false 的触发事件", async () => {
    const { group, creator } = await stageGroup();
    const clientMsgId = await sendViaApi(group, creator, "mine");
    await tick();
    await waitFor(
      async () => (await simState()).messages.length === 1,
      "网关侧落地",
    );
    const landed = (await simState()).messages[0]!;
    const sim = await simState();
    // 网关确实把自己的消息作为 message 事件推回来了（msgId 与 message_sent 相同）
    expect(sim.events.byType).toMatchObject({ message_sent: 1, message: 1 });

    const frames = await consumeToLatest();
    expect(frames).toBe(2);
    const rows = await getDb().message.findMany({
      where: { groupId: group.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientMsgId,
      msgId: landed.msgId,
      isOwn: true,
      accountId: creator.id,
      senderPlatformUserId: creator.platformUserId,
      text: "mine",
      deliveryStatus: "sent",
    });
    expect(await timeline(group)).toEqual([
      expect.objectContaining({ msgId: landed.msgId, isOwn: true }),
    ]);
    // agent 触发点：没有 isOwn = false 的 message 事件（摘掉「按 platformUserId 反查服务账号」就会多一条 isOwn=false）
    const events = await wsMessageEvents();
    expect(events.filter((e) => e.isOwn === false)).toHaveLength(0);
    expect(events.every((e) => e.isOwn === true)).toBe(true);

    // 补投同一条（新 eventId、原 msgId）：仍一行、不再发事件
    const eventsBefore = events.length;
    await push({ kind: "redeliver", msgId: landed.msgId });
    expect(await consumeToLatest()).toBe(1);
    expect(await getDb().message.count({ where: { groupId: group.id } })).toBe(
      1,
    );
    expect(await wsMessageEvents()).toHaveLength(eventsBefore);
    expect(await getDb().inconsistency.count()).toBe(0);
  });

  // ---- S4 ------------------------------------------------------------------------------

  it("S4 限流：429 → rate_limited；到期前网关收不到该账号的 send；限流 worker 到期自动恢复 → 按原顺序发出 → 全部 sent", async () => {
    const { group, creator: a } = await stageGroup();
    const b = await addMember(group);
    const retryAfterSeconds = 5;
    await scenario({
      send: {
        responses: [
          { status: 429, retryAfterSeconds, match: { accountId: a.id } },
        ],
      },
    });
    const a1 = await sendViaApi(group, a, "a-1");
    clock.advance(1);
    const a2 = await sendViaApi(group, a, "a-2");
    clock.advance(1);
    const b1 = await sendViaApi(group, b, "b-1");

    // tick 1：a-1 吃到 429 → a 进入 rate_limited（rateLimitedUntil = now + N）；b-1 照常 202
    const s1 = await tick();
    expect(s1.outcomes).toMatchObject({ requeued: 1, accepted: 1 });
    const limitedAt = clock.now();
    const accounts = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers: admin,
    });
    expect(accounts.statusCode).toBe(200);
    const aRead = accounts
      .json<{ id: string; status: string; rateLimitedUntil: string | null }[]>()
      .find((x) => x.id === a.id)!;
    expect(aRead.status).toBe("rate_limited");
    expect(new Date(aRead.rateLimitedUntil!).getTime()).toBe(
      limitedAt.getTime() + retryAfterSeconds * 1000,
    );
    expect(await rowByClientMsgId(a1)).toMatchObject({
      deliveryStatus: "queued",
      claimedBy: null,
    });
    expect((await rowByClientMsgId(a2)).deliveryStatus).toBe("queued");
    expect((await rowByClientMsgId(b1)).deliveryStatus).toBe("accepted");

    // 到期前：再多的 tick 网关都收不到 a 的 send（摘掉 claimBatch 的限流条件，这里 a-1 会再被发一次并再吃 429）
    const sendsOf = (sim: SimState, accountId: string) =>
      sim.sendCalls.filter((c) => c.accountId === accountId).length;
    clock.advance(retryAfterSeconds * 1000 - 1);
    for (let i = 0; i < 3; i++) {
      expect((await tick()).claimed).toBe(0);
    }
    expect(sendsOf(await simState(), a.id)).toBe(1);
    expect(sendsOf(await simState(), b.id)).toBe(1);

    // 到期：限流 worker 自动把账号恢复 online（intervalMs 只是多久看一次，到期时刻在库里）
    clock.advance(1);
    const rateLimitWorker = startRateLimitWorker({
      clock,
      intervalMs: 10,
      log: silent,
    });
    stoppers.push(() => rateLimitWorker.stop());
    await waitFor(
      async () =>
        (await getDb().account.findUniqueOrThrow({ where: { id: a.id } }))
          .status === "online",
      "限流到期自动恢复",
    );
    await rateLimitWorker.stop();

    // 恢复后按原顺序发出：同账号一次只在途一条，所以 a-1 先、a-2 后
    expect((await tick()).claimed).toBe(1);
    expect((await rowByClientMsgId(a1)).deliveryStatus).toBe("accepted");
    expect((await rowByClientMsgId(a2)).deliveryStatus).toBe("queued");
    clock.advance(1);
    expect((await tick()).claimed).toBe(1);
    expect((await rowByClientMsgId(a2)).deliveryStatus).toBe("accepted");
    await waitFor(
      async () => (await simState()).messages.length === 3,
      "三条都在网关落地",
    );
    let sim = await simState();
    expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
      [a1, 429],
      [b1, 202],
      [a1, 202],
      [a2, 202],
    ]);
    expect(
      sim.messages.filter((m) => m.clientMsgId !== null).map((m) => m.text),
    ).toEqual(["b-1", "a-1", "a-2"]);

    // 入站 worker 消费 message_sent → 三条都 sent；时间线三行、按网关 sentAt
    await consumeToLatest();
    for (const id of [a1, a2, b1]) {
      expect((await rowByClientMsgId(id)).deliveryStatus).toBe("sent");
    }
    expect((await timeline(group)).map((m) => m.text)).toEqual([
      "a-2",
      "a-1",
      "b-1",
    ]);
    expect(await getDb().message.count()).toBe(3);
    sim = await simState();
    expect(sim.sendCalls).toHaveLength(4);
    expect(sim.messages).toHaveLength(3);
  });
});
