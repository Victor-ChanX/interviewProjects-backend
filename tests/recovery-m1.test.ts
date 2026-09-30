// issue #10：重启恢复与并发（题目第 3 节总则「每一条行为在服务任意时刻重启前后都必须成立」+ A2 + A1 终态级联）。
//
// 「死掉」的定义：进程在某一步之后**没有下一步** —— 库里留下的是那一步 commit 后的状态，内存里的一切（在途的
// Promise、领取标记的持有者）都没了。测法：旧实例被驱动到缝上就再也不往下走（网关调用永远不返回 / 游标永远
// 不推进），新实例（另一个 workerId、另一次 consumeOnce）带着库里的状态接手。断言的是**外部效果的次数**
// （网关模拟器 /_sim/state 的 messages 与 sendCalls），不只是终态 —— 终态对、网关里两条消息，才是 A2 禁止的事。
//
// 真库（tests/setup.ts 的临时 schema）；网关用 src/sim/gateway 的 buildGatewayApp 起在 listen(0)，出站 worker
// 与入站 worker 都经 createGatewayClient 走真 HTTP / 真 SSE。时间：应用、service、worker、模拟器共用一个假 Clock，
// 回收阈值 / 2 秒确认窗口都靠 clock.advance 推，不真 sleep；只有模拟器「202 后落地」走 setTimeout(0)，用短轮询等。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Account, Group } from "../src/db/generated/client.js";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayEvent,
} from "../src/services/gateway-client.js";
import {
  advanceCursor,
  ingest,
  readCursor,
} from "../src/services/inbound-service.js";
import {
  applyGatewayDelivery,
  enqueueMessage,
  STALE_CLAIM_MS,
} from "../src/services/outbox-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { consumeOnce } from "../src/workers/inbound-worker.js";
import {
  runOutboxTick,
  startOutboxWorker,
} from "../src/workers/outbox-worker.js";
import {
  deliverGatewayReceipt,
  loginAs,
  makeAccount,
  makeGroup,
  makeMessage,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

/** 题目 2.1：504 之后超过 2 秒仍 404 即可确定没发出（测试的预言机，不从 service 导入） */
const CONFIRM_WINDOW_MS = 2_000;

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

/** 短轮询等条件成立（真定时器；只用于模拟器 setTimeout(0) 的落地与 SSE 建连，不等固定时长） */
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
  messages: { msgId: string; clientMsgId: string | null; sentAt: string }[];
  events: { lastEventId: number };
  streams: { open: number };
};

/**
 * 「死在缝上」的网关客户端：send 走到指定的缝就永远不返回 —— 旧实例的 tick 从此挂起，等于进程没了下一步。
 * before-send：领取已 commit、请求还没发出；after-202：网关已受理（模拟器里有这条），记账还没写。
 */
function dyingGateway(
  real: GatewayClient,
  seam: "before-send" | "after-202",
): { gateway: GatewayClient; died: Promise<void> } {
  let markDied: () => void = () => undefined;
  const died = new Promise<void>((resolve) => {
    markDied = resolve;
  });
  const gateway: GatewayClient = {
    ...real,
    async send(input) {
      if (seam === "after-202") await real.send(input);
      markDied();
      return new Promise<never>(() => undefined);
    },
  };
  return { gateway, died };
}

/** 一帧 account_status（入站 worker 收到时就是这样调 ingest 的） */
function accountStatusFrame(
  eventId: number,
  accountId: string,
  status: "suspended" | "session_expired",
): GatewayEvent {
  return {
    eventId,
    type: "account_status",
    data: { eventId, type: "account_status", accountId, status },
  };
}

describe("重启恢复与并发（#10）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;

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
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    // 202 立刻回、message_sent 立刻推；事件是否到达由本文件用 consumeOnce 决定
    await scenario({ send: { acceptDelayMs: 0, eventDelayMs: 0 } });
    // 游标置 0：入站 worker 首连带 since=0 回放全部（游标为 null 时不带 since = 首次部署语义，不是这里要测的）
    await advanceCursor(0, { clock });
    admin = await loginAs(app, "admin");
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
  const push = (payload: Json) =>
    gateway.inject({ method: "POST", url: "/_sim/push", payload });

  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  /** 一个在线账号当群主，在网关 + 本地各建一个群，本地成员表写入群主 */
  async function stageGroup(): Promise<{ group: Group; creator: Account }> {
    const creatorId = `acc-${randomUUID().slice(0, 8)}`;
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

  /** 再加一个在线成员账号：网关 connect + 网关入群（推 member_joined）+ 本地成员行 */
  async function addMember(group: Group): Promise<Account> {
    const id = `acc-${randomUUID().slice(0, 8)}`;
    const platformUserId = await connectAtGateway(id);
    const account = await makeAccount({ id, status: "online", platformUserId });
    const joined = await push({
      kind: "member_joined",
      groupId: group.gatewayGroupId,
      platformUserId,
    });
    expect(joined.statusCode).toBe(200);
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

  const enqueue = (group: Group, account: Account, text = "hi") =>
    enqueueMessage(
      { groupId: group.id, accountId: account.id, text, source: "operator" },
      { clock, log: silent },
    );

  const tick = (workerId: string, gw: GatewayClient = gatewayClient) =>
    runOutboxTick({ clock, gateway: gw, workerId, log: silent });

  const row = (id: string) =>
    getDb().message.findUniqueOrThrow({ where: { id } });
  const attemptsOf = async (messageId: string) =>
    (
      await getDb().outboundAttempt.findMany({
        where: { messageId },
        orderBy: { attemptNo: "asc" },
      })
    ).map((a) => [a.attemptNo, a.httpStatus, a.errorCode]);
  const statusEventsOf = async (clientMsgId: string) =>
    (
      await getDb().wsEvent.findMany({
        where: { type: "message" },
        orderBy: { id: "asc" },
      })
    )
      .map((e) => e.payload as Json)
      .filter((p) => p.clientMsgId === clientMsgId)
      .map((p) => p.deliveryStatus);

  /**
   * 入站 worker 的一次连接（真 SSE）：从库里的游标起消费，每帧 ingest + 推进游标之后判 stop，为真就停
   * （相当于 stop()）。message_sent / message_failed 的记账注入 outbox-service.applyGatewayDelivery，
   * 与 src/main.ts 的接法相同。返回这条连接收到的帧数。
   */
  async function consume(
    stop: (processed: number, eventId: number) => boolean,
    opts: { advance?: (eventId: number) => Promise<void> } = {},
  ): Promise<number> {
    const ac = new AbortController();
    let processed = 0;
    const result = await consumeOnce(
      {
        clock,
        gateway: gatewayClient,
        log: silent,
        applyGatewayDelivery,
        cursorStore: {
          read: readCursor,
          advance: async (eventId) => {
            await (opts.advance ?? ((id) => advanceCursor(id, { clock })))(
              eventId,
            );
            processed += 1;
            if (stop(processed, eventId)) ac.abort();
          },
        },
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

  // ---- 1. 出站 worker 在三个缝上死掉 -------------------------------------------------------

  describe("出站 worker：死在缝上，新实例接手，网关恰好一条", () => {
    it("(a) 领取后、调网关前死掉：新实例按过期领取回收 → unknown → by-client-id 404 满 2 秒 → 重发一次；网关恰好一条", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator, "a");

      // 旧实例 dead-a：领取已 commit，请求还没发出去就死了
      const dying = dyingGateway(gatewayClient, "before-send");
      void tick("dead-a", dying.gateway);
      await dying.died;

      // 库里的中间态：queued + 领取标记 + attempts 1 + 一行未收口的 outbound_attempts；网关一无所知
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "queued",
        claimedBy: "dead-a",
        attempts: 1,
        resendCount: 0,
      });
      expect((await row(messageId)).lockedAt?.getTime()).toBe(
        clock.now().getTime(),
      );
      expect(await attemptsOf(messageId)).toEqual([[1, null, null]]);
      expect((await simState()).sendCalls).toHaveLength(0);

      // 新实例 w2 立刻接手：阈值内不能把别人领着的行当成自己的（摘掉 claimBatch 的 claimed_by IS NULL 这里就会
      // 领到它、多发一条），也不能回收
      let s = await tick("w2");
      expect(s).toMatchObject({ recovered: 0, claimed: 0 });
      expect((await row(messageId)).claimedBy).toBe("dead-a");
      expect((await simState()).sendCalls).toHaveLength(0);

      // 过了回收阈值：转 unknown 走确认，而不是直接放回 queued 重发（摘掉「回收 → unknown」改成回 queued，
      // 这一步就会直接重发 —— 这条用例网关仍恰好一条，但 (b) 会变成两条）
      clock.advance(STALE_CLAIM_MS + 1);
      s = await tick("w2");
      expect(s).toMatchObject({ recovered: 1, unknownChecked: 1, claimed: 0 });
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "unknown",
        claimedBy: null,
        lockedAt: null,
      });
      expect((await row(messageId)).unknownSince?.getTime()).toBe(
        clock.now().getTime(),
      );
      expect((await simState()).sendCalls).toHaveLength(0);

      // 2 秒窗口内 by-client-id 仍 404：不重发（摘掉 UNKNOWN_CONFIRM_MS 的判断这里就会提前重发）
      clock.advance(CONFIRM_WINDOW_MS - 1);
      s = await tick("w2");
      expect(s).toMatchObject({ unknownChecked: 1, claimed: 0 });
      expect((await row(messageId)).deliveryStatus).toBe("unknown");
      expect((await simState()).sendCalls).toHaveLength(0);

      // 满 2 秒仍 404 = 确认没发出：同一 clientMsgId 重发一次，同一 tick 里领取并发出
      clock.advance(2);
      s = await tick("w2");
      expect(s).toMatchObject({ unknownChecked: 1, claimed: 1 });
      expect(s.outcomes.accepted).toBe(1);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        resendCount: 1,
        attempts: 2,
        claimedBy: null,
      });
      expect(await attemptsOf(messageId)).toEqual([
        [1, null, "CLAIM_LOST"],
        [2, 202, null],
      ]);
      await waitFor(
        async () => (await simState()).messages.length === 1,
        "重发的消息在网关落地",
      );
      let sim = await simState();
      expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [clientMsgId, 202],
      ]);
      expect(sim.messages.map((m) => m.clientMsgId)).toEqual([clientMsgId]);

      // message_sent 由入站 worker 消费后 → sent；回流的 message 事件合并进出站行，不多一行
      await consumeToLatest();
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "sent",
        msgId: sim.messages[0]!.msgId,
      });
      expect(await getDb().message.count()).toBe(1);
      expect(await statusEventsOf(clientMsgId)).toEqual([
        "queued",
        "unknown",
        "queued",
        "accepted",
        "sent",
      ]);
      sim = await simState();
      expect(sim.sendCalls).toHaveLength(1);
      expect(sim.messages).toHaveLength(1);
    });

    it("(b) 网关 202 后、记账前死掉：新实例回收 → unknown → by-client-id 200 → sent；网关恰好一条，无重发", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator, "b");

      // 旧实例 dead-b：请求发出、网关 202 并落地，记账那一步永远没发生
      const dying = dyingGateway(gatewayClient, "after-202");
      void tick("dead-b", dying.gateway);
      await dying.died;
      await waitFor(
        async () => (await simState()).messages.length === 1,
        "网关侧落地",
      );

      // 库里看不出网关已经收下：仍是 queued + 领取标记（这正是「先记再发」留下的痕迹，重启后按它处理）
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "queued",
        claimedBy: "dead-b",
        attempts: 1,
        acceptedAt: null,
      });
      expect(await attemptsOf(messageId)).toEqual([[1, null, null]]);

      // 新实例阈值内：不领、不回收、不重发
      let s = await tick("w2");
      expect(s).toMatchObject({ recovered: 0, claimed: 0 });
      expect((await simState()).sendCalls).toHaveLength(1);

      // 过阈值：回收成 unknown，同一 tick 里 by-client-id 查到 200 → sent，不再领取、不再 send
      // （摘掉 recoverStaleClaims 里的「转 unknown」改成回 queued，这里网关就会收到第二条 —— 见回报里的变异验证）
      clock.advance(STALE_CLAIM_MS + 1);
      s = await tick("w2");
      expect(s).toMatchObject({ recovered: 1, unknownChecked: 1, claimed: 0 });
      const landed = (await simState()).messages[0]!;
      const sent = await row(messageId);
      expect(sent).toMatchObject({
        deliveryStatus: "sent",
        msgId: landed.msgId,
        resendCount: 0,
        attempts: 1,
        claimedBy: null,
        unknownSince: null,
      });
      expect(sent.sentAt.toISOString()).toBe(landed.sentAt);
      // 账本：只有死掉那次，以 CLAIM_LOST 收口；没有第二次投递
      expect(await attemptsOf(messageId)).toEqual([[1, null, "CLAIM_LOST"]]);
      expect(await statusEventsOf(clientMsgId)).toEqual([
        "queued",
        "unknown",
        "sent",
      ]);

      // 之后再怎么 tick 都不会再发；message_sent 事件到达是重复的，不改、不再发事件
      s = await tick("w2");
      expect(s).toMatchObject({ recovered: 0, unknownChecked: 0, claimed: 0 });
      const eventsBefore = await getDb().wsEvent.count();
      await consumeToLatest();
      expect(await getDb().wsEvent.count()).toBe(eventsBefore + 1); // 只多回流 message 事件那一条
      expect(await getDb().message.count()).toBe(1);
      const sim = await simState();
      expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [clientMsgId, 202],
      ]);
      expect(sim.messages).toHaveLength(1);
    });

    it("(c) 记账 accepted 后、message_sent 到达前停机：新实例照常（不重领 accepted 行），事件到达后 sent", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator, "c");

      // 每个实例只跑一个 tick 然后停在等待上：stop() 打断等待、等在途 tick 完成后返回（优雅停机）
      const parkedSleep = () => {
        let cancel: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
          cancel = resolve;
        });
        return { promise, cancel };
      };
      const first = startOutboxWorker({
        clock,
        gateway: gatewayClient,
        workerId: "w1",
        intervalMs: 1,
        sleep: parkedSleep,
        log: silent,
      });
      // stop 等在途 tick 做完记账才返回：不在网关调用中途退出（那正是制造 unknown 的方法）
      await first.stop();

      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        claimedBy: null,
        msgId: null,
        attempts: 1,
      });
      expect(await attemptsOf(messageId)).toEqual([[1, 202, null]]);
      await waitFor(
        async () => (await simState()).messages.length === 1,
        "网关侧落地",
      );

      // 新实例：accepted 行不是 queued，领取语句碰不到它（摘掉 delivery_status = 'queued' 的条件就会重发）
      const second = startOutboxWorker({
        clock,
        gateway: gatewayClient,
        workerId: "w2",
        intervalMs: 1,
        sleep: parkedSleep,
        log: silent,
      });
      await second.stop();
      clock.advance(STALE_CLAIM_MS + 1);
      const s = await tick("w3");
      expect(s).toMatchObject({ recovered: 0, unknownChecked: 0, claimed: 0 });
      expect((await row(messageId)).deliveryStatus).toBe("accepted");

      // message_sent 到达 → sent；回流 message 合并
      await consumeToLatest();
      const landed = (await simState()).messages[0]!;
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "sent",
        msgId: landed.msgId,
      });
      expect(await getDb().message.count()).toBe(1);
      expect(await statusEventsOf(clientMsgId)).toEqual([
        "queued",
        "accepted",
        "sent",
      ]);
      const sim = await simState();
      expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [clientMsgId, 202],
      ]);
      expect(sim.messages).toHaveLength(1);
    });
  });

  // ---- 2. 入站 worker 死在「处理后、推进游标前」 ---------------------------------------------

  describe("入站 worker：死在处理后、推进游标前", () => {
    it("新实例带旧游标重拉，重放的那批被去重吃掉：inbound_events 与 messages 都不多一行", async () => {
      const { group } = await stageGroup();
      const n = 4;
      for (let i = 0; i < n; i++) {
        await push({
          kind: "message",
          groupId: group.gatewayGroupId,
          senderPlatformUserId: "ext-1",
          text: `t${i}`,
          sentAt: new Date(clock.now().getTime() + i * 1000).toISOString(),
        });
      }

      // 旧实例：第 2 帧 ingest 完（行已写、processedAt 已写），游标那一步没做就没了
      const killAt = 2;
      const frames1 = await consume((_n, eventId) => eventId === killAt, {
        advance: async (eventId) => {
          if (eventId === killAt) return; // 死在这里：游标不推进
          await advanceCursor(eventId, { clock });
        },
      });
      expect(frames1).toBe(killAt);
      expect(await readCursor()).toBe(killAt - 1);
      expect(await getDb().inboundEvent.count()).toBe(killAt);
      expect(
        await getDb().message.count({ where: { groupId: group.id } }),
      ).toBe(killAt);

      // 新实例：since = 1 → 第 2 帧再来一次（重放），第 3、4 帧正常。重放那帧必须真的到了（frames 数），
      // 且被事件级去重吃掉（摘掉 inbound_events.eventId 的唯一约束 / P2002 分支，这里会多一行、时间线多一条）
      const frames2 = await consume((_n, eventId) => eventId >= n);
      expect(frames2).toBe(n - killAt + 1);
      expect(await readCursor()).toBe(n);
      expect(await getDb().inboundEvent.count()).toBe(n);
      expect(
        await getDb().inboundEvent.count({ where: { processedAt: null } }),
      ).toBe(0);
      const rows = await getDb().message.findMany({
        where: { groupId: group.id },
        orderBy: { sentAt: "asc" },
      });
      expect(rows.map((m) => m.text)).toEqual(["t0", "t1", "t2", "t3"]);
      // 时间线事件也不重复：每条消息恰好一次
      expect(await getDb().wsEvent.count({ where: { type: "message" } })).toBe(
        n,
      );
      expect(await getDb().inconsistency.count()).toBe(0);
    });
  });

  // ---- 3. 停机期间网关产生的事件 ---------------------------------------------------------

  describe("停机期间网关产生的事件", () => {
    it("message / member_joined / account_status 混推 N 条 → 恢复后全部处理到，时间线按 sentAt", async () => {
      const { group, creator } = await stageGroup();
      const member = await addMember(group);
      // 实例 1 消费到目前为止的事件（addMember 推的 member_joined），然后停机
      const before = (await simState()).events.lastEventId;
      expect(before).toBeGreaterThan(0);
      await consumeToLatest();
      expect(await readCursor()).toBe(before);

      // 停机期间：乱序的 sentAt、外部用户进群、成员账号被平台停用（网关会再推 member_left）
      const base = clock.now().getTime();
      const at = (ms: number) => new Date(base + ms).toISOString();
      await push({
        kind: "message",
        groupId: group.gatewayGroupId,
        senderPlatformUserId: "ext-1",
        text: "second",
        sentAt: at(2_000),
      });
      await push({
        kind: "member_joined",
        groupId: group.gatewayGroupId,
        platformUserId: "ext-9",
      });
      await push({
        kind: "message",
        groupId: group.gatewayGroupId,
        senderPlatformUserId: "ext-9",
        text: "first",
        sentAt: at(1_000),
      });
      await push({
        kind: "account_status",
        accountId: member.id,
        status: "suspended",
      });
      await push({
        kind: "message",
        groupId: group.gatewayGroupId,
        senderPlatformUserId: "ext-1",
        text: "third",
        sentAt: at(3_000),
      });
      const after = (await simState()).events.lastEventId;
      // account_status 之外网关还推了一条 member_left（member 在网关群里）
      expect(after).toBe(before + 6);
      // 停机中：本地什么都没变
      expect(await getDb().message.count()).toBe(0);
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: member.id } }))
          .status,
      ).toBe("online");

      // 实例 2：从游标之后补拉（摘掉 readCursor / since，改成从「现在」开始，这些事件就永久丢了）
      const frames = await consumeToLatest();
      expect(frames).toBe(after - before);
      expect(await readCursor()).toBe(after);
      expect(await getDb().inboundEvent.count()).toBe(after);
      expect(
        await getDb().inboundEvent.count({ where: { processedAt: null } }),
      ).toBe(0);
      expect(await getDb().inconsistency.count()).toBe(0);

      // 时间线（API，按 sentAt 倒序）
      const page = await app.inject({
        method: "GET",
        url: `/api/groups/${group.id}/messages`,
        headers: admin,
      });
      expect(page.statusCode).toBe(200);
      expect(
        page.json<{ items: { text: string }[] }>().items.map((m) => m.text),
      ).toEqual(["third", "second", "first"]);

      // 成员表：ext-9 进来了；member 因终态被移出（级联 + member_left 都是空操作也没关系）；群主还在
      const members = await getDb().groupMember.findMany({
        where: { groupId: group.id },
        orderBy: { platformUserId: "asc" },
      });
      expect(members.map((m) => m.platformUserId).sort()).toEqual(
        [creator.platformUserId!, "ext-9"].sort(),
      );
      // 账号终态与级联恰好一次
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: member.id } }))
          .status,
      ).toBe("suspended");
      expect(
        await getDb().wsEvent.count({ where: { type: "account_terminal" } }),
      ).toBe(1);
      expect(
        await getDb().wsEvent.count({ where: { type: "member_changed" } }),
      ).toBe(3); // 停机前 member joined + 停机期间 ext-9 joined、member left
    });
  });

  // ---- 4. 终态级联的并发 ---------------------------------------------------------------

  describe("终态级联的并发：两个来源同时进入终态", () => {
    /** 一个在线成员账号 + 它排队中的一条出站消息（级联要动的两样东西） */
    async function stageForCascade() {
      const account = await makeAccount({ status: "online" });
      const group = await makeGroup({ creatorAccountId: account.id });
      await getDb().groupMember.create({
        data: {
          groupId: group.id,
          platformUserId: account.platformUserId!,
          accountId: account.id,
          role: "creator",
        },
      });
      const queued = await makeMessage({
        groupId: group.id,
        accountId: account.id,
        clientMsgId: randomUUID(),
        senderPlatformUserId: account.platformUserId!,
        isOwn: true,
        deliveryStatus: "queued",
      });
      return { account, group, queued };
    }

    async function assertCascadedOnce(account: Account, queuedId: string) {
      const fresh = await getDb().account.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(fresh.status).toBe("suspended");
      // CAS：恰好一次写入（两个来源都写成功 version 会 +2）
      expect(fresh.version).toBe(account.version + 1);
      expect(
        await getDb().groupMember.count({ where: { accountId: account.id } }),
      ).toBe(0);
      expect(await row(queuedId)).toMatchObject({
        deliveryStatus: "cancelled",
        failCode: "ACCOUNT_TERMINAL",
      });
      const events = await getDb().wsEvent.findMany({
        where: { type: { in: ["account_terminal", "account_status_changed"] } },
        orderBy: { id: "asc" },
      });
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        [
          "account_status_changed",
          { accountId: account.id, from: "online", to: "suspended" },
        ],
        ["account_terminal", { accountId: account.id, status: "suspended" }],
      ]);
      // 输的一方不能变成「事件处理失败」进不一致
      expect(await getDb().inconsistency.count()).toBe(0);
    }

    it("网关 account_status 事件（ingest）+ 操作员 transition 并发：恰好一次级联、结果一致、ws_events 恰好一条 account_terminal", async () => {
      // 多跑几轮让两条路径真的交错（各自一个 $transaction、各占一条池连接）
      for (let round = 1; round <= 3; round++) {
        await truncateAll();
        admin = await loginAs(app, "admin");
        const { account, queued } = await stageForCascade();

        const [ingested, operator] = await Promise.all([
          ingest(accountStatusFrame(round, account.id, "suspended"), {
            clock,
            log: silent,
          }),
          app.inject({
            method: "POST",
            url: `/api/accounts/${account.id}/transition`,
            headers: admin,
            payload: { to: "suspended", expectedFrom: "online" },
          }),
        ]);

        // 网关事件这一侧：撞 CAS 会重读再试，读到已是终态就静默 —— 永远是 processed，不是 failed
        expect(ingested).toEqual({ eventId: round, outcome: "processed" });
        // 操作员这一侧：赢了 200 changed=true；读到已是终态 200 changed=false；写时撞 CAS 409（题目 A1 允许）
        if (operator.statusCode === 200) {
          expect(operator.json()).toMatchObject({ status: "suspended" });
        } else {
          expect(operator.statusCode).toBe(409);
          expect(operator.json()).toMatchObject({
            error: { code: "CAS_CONFLICT" },
          });
        }
        await assertCascadedOnce(account, queued.id);
      }
    });

    it("三个来源同时进终态（网关事件 + 发送错误 message_failed + 操作员）：级联仍恰好一次；重复进入不报错", async () => {
      const { account, queued } = await stageForCascade();
      const results = await Promise.allSettled([
        ingest(accountStatusFrame(1, account.id, "suspended"), {
          clock,
          log: silent,
        }),
        deliverGatewayReceipt(
          { clientMsgId: queued.clientMsgId!, code: "ACCOUNT_SUSPENDED" },
          { clock, log: silent },
        ),
        app.inject({
          method: "POST",
          url: `/api/accounts/${account.id}/transition`,
          headers: admin,
          payload: { to: "suspended", expectedFrom: "online" },
        }),
      ]);
      // service 层的两路都不抛（CAS 重试 / 静默）；HTTP 那路 200 或 409 CAS_CONFLICT
      expect(results[0]).toMatchObject({
        status: "fulfilled",
        value: { outcome: "processed" },
      });
      expect(results[1].status).toBe("fulfilled");
      expect(results[2].status).toBe("fulfilled");

      const fresh = await getDb().account.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(fresh.status).toBe("suspended");
      expect(fresh.version).toBe(account.version + 1);
      expect(
        await getDb().wsEvent.count({ where: { type: "account_terminal" } }),
      ).toBe(1);
      expect(
        await getDb().groupMember.count({ where: { accountId: account.id } }),
      ).toBe(0);
      // 那条消息要么被级联取消（ACCOUNT_TERMINAL），要么被 message_failed 记成 failed（ACCOUNT_SUSPENDED）——
      // 取决于谁先到，但一定是终态之一，且不会再被发出
      const m = await row(queued.id);
      expect(
        [
          ["cancelled", "ACCOUNT_TERMINAL"],
          ["failed", "ACCOUNT_SUSPENDED"],
        ].some(([s, c]) => m.deliveryStatus === s && m.failCode === c),
      ).toBe(true);

      // 再来一次同样的事件：静默，不再级联、不再发事件
      const again = await ingest(
        accountStatusFrame(2, account.id, "suspended"),
        {
          clock,
          log: silent,
        },
      );
      expect(again.outcome).toBe("processed");
      expect(
        await getDb().wsEvent.count({ where: { type: "account_terminal" } }),
      ).toBe(1);
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .version,
      ).toBe(account.version + 1);
    });
  });
});
