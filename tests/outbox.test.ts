// issue #7：出站 outbox（题目 2.1「发消息」、2.3 POST /api/groups/:id/send、A2 错误表、S1 / S4）。
// 真库（tests/setup.ts 的临时 schema）；网关用 src/sim/gateway 的 buildGatewayApp 起在 listen(0) 上，
// 应用与 worker 都经 createGatewayClient({ baseUrl }) 走真 HTTP（setup.ts 的 MockAgent 放行 localhost）。
// 时间：应用、service、worker、网关模拟器共用一个可拨动的假 Clock（clock.advance 同时推动本地的限流截止 /
// 2 秒确认窗口与网关侧的限流期），不真 sleep；只有模拟器「504 后落地」用 setTimeout(0) 时等几毫秒。
// worker 不起循环：直接 await runOutboxTick()，一个 tick = 回收 → 确认 unknown → 领取 → 派发。
// message_sent / message_failed 事件流由 #8 消费；这里用 factories 的 deliverGatewayReceipt（事务里调 applyGatewayDelivery）模拟它。
// 多连接真并行的领取用例在 tests/outbox-concurrency.test.ts。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type {
  Account,
  AccountStatus,
  Group,
} from "../src/db/generated/client.js";
import {
  enterTerminalInTx,
  recoverRateLimited,
} from "../src/services/account-service.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import {
  claimBatch,
  dispatchOne,
  enqueueMessage,
  STALE_CLAIM_MS,
} from "../src/services/outbox-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import {
  runConfirmTick,
  runDispatchTick,
  runOutboxTick,
} from "../src/workers/outbox-worker.js";
import {
  deliverGatewayReceipt,
  loginAs,
  makeAccount,
  makeGroup,
  withFailingUpdates,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

/** 题目 2.1：504 之后超过 2 秒仍 404 即可确定没发出（测试的预言机，不从 service 导入） */
const CONFIRM_WINDOW_MS = 2_000;

/** 可拨动的假时钟：应用、worker 与网关模拟器共用 */
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

/** 模拟器「504 后 landAfterMs 落地」走 setTimeout(0)：给它几毫秒 */
const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const silent = logger.child({}, { level: "silent" });

type SimState = {
  sendCalls: {
    accountId: string;
    groupId: string;
    clientMsgId: string;
    status: number;
    code: string | null;
  }[];
  messages: { msgId: string; clientMsgId: string | null; sentAt: string }[];
  groups: { groupId: string; writeForbidden: boolean }[];
};

describe("outbox（#7）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

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
    // 202 立刻回、message_sent 立刻推：本文件不消费事件流，只要模拟器的状态确定
    await scenario({ send: { acceptDelayMs: 0, eventDelayMs: 0 } });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
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

  /** 在网关 connect 一个账号，拿它的 platformUserId */
  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  /**
   * 布景：一个在线账号（本地 + 网关都 online，platformUserId 一致）当群主建一个群（本地 + 网关），
   * 本地成员表写入群主。
   */
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

  /**
   * 再加一个成员账号。默认：网关 connect + 网关入群 + 本地成员行。
   * gatewayMember = false：只在本地成员表里（网关会回 SENDER_NOT_IN_GROUP）；
   * connected = false：网关没 connect（会回 ACCOUNT_OFFLINE）。
   */
  async function addMember(
    group: Group,
    opts: {
      status?: AccountStatus;
      gatewayMember?: boolean;
      connected?: boolean;
      rateLimitedUntil?: Date;
    } = {},
  ): Promise<Account> {
    const id = `acc-${randomUUID().slice(0, 8)}`;
    const platformUserId =
      opts.connected === false ? `pu-${id}` : await connectAtGateway(id);
    const account = await makeAccount({
      id,
      status: opts.status ?? "online",
      platformUserId,
      ...(opts.rateLimitedUntil
        ? { rateLimitedUntil: opts.rateLimitedUntil }
        : {}),
    });
    if (opts.gatewayMember !== false && opts.connected !== false) {
      const joined = await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "member_joined",
          groupId: group.gatewayGroupId,
          platformUserId,
        },
      });
      expect(joined.statusCode).toBe(200);
    }
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

  async function enqueue(group: Group, account: Account, text = "hi") {
    const { clientMsgId, messageId } = await enqueueMessage(
      { groupId: group.id, accountId: account.id, text, source: "operator" },
      { clock, log: silent },
    );
    return { clientMsgId, messageId };
  }

  const tick = (workerId = "w1") =>
    runOutboxTick({ clock, gateway: gatewayClient, workerId, log: silent });

  const row = (id: string) =>
    getDb().message.findUniqueOrThrow({ where: { id } });
  const account = (id: string) =>
    getDb().account.findUniqueOrThrow({ where: { id } });
  const messageEvents = async () =>
    (
      await getDb().wsEvent.findMany({
        where: { type: "message" },
        orderBy: { id: "asc" },
      })
    ).map((e) => e.payload as Json);

  // ---- POST /api/groups/:id/send ---------------------------------------------------------

  describe("POST /api/groups/:id/send", () => {
    it("主流程：admin 202 { clientMsgId }；行 queued / isOwn / sentAt = 受理时刻；同事务写 ws_events message", async () => {
      const { group, creator } = await stageGroup();
      const before = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: creator.id, text: "hello" },
      });
      expect(res.statusCode).toBe(202);
      const { clientMsgId } = res.json<{ clientMsgId: string }>();
      expect(clientMsgId).toMatch(/^[0-9a-f-]{36}$/);

      const m = await getDb().message.findUniqueOrThrow({
        where: { clientMsgId },
      });
      expect(m).toMatchObject({
        groupId: group.id,
        accountId: creator.id,
        senderPlatformUserId: creator.platformUserId,
        isOwn: true,
        text: "hello",
        deliveryStatus: "queued",
        msgId: null,
        failCode: null,
        attempts: 0,
        resendCount: 0,
        claimedBy: null,
      });
      expect(m.sentAt.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(m.sentAt.getTime()).toBeLessThanOrEqual(Date.now() + 5);
      expect(await messageEvents()).toEqual([
        {
          groupId: group.id,
          msgId: null,
          clientMsgId,
          isOwn: true,
          deliveryStatus: "queued",
          failCode: null,
        },
      ]);
      // 202 只保证落库：网关还没收到
      expect((await simState()).sendCalls).toHaveLength(0);
    });

    it("rate_limited 的账号照常受理，保持 queued", async () => {
      const { group } = await stageGroup();
      const limited = await addMember(group, {
        status: "rate_limited",
        rateLimitedUntil: new Date(clock.now().getTime() + 30_000),
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: limited.id, text: "later" },
      });
      expect(res.statusCode).toBe(202);
      const m = await getDb().message.findUniqueOrThrow({
        where: { clientMsgId: res.json<{ clientMsgId: string }>().clientMsgId },
      });
      expect(m.deliveryStatus).toBe("queued");
    });

    it("账号不是群成员 → 409 ACCOUNT_NOT_IN_GROUP，不落库", async () => {
      const { group } = await stageGroup();
      const outsider = await makeAccount({ status: "online" });
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: outsider.id, text: "x" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "ACCOUNT_NOT_IN_GROUP", accountId: outsider.id },
      });
      expect(await getDb().message.count()).toBe(0);
      expect(await getDb().wsEvent.count()).toBe(0);
    });

    it.each(["idle", "disconnected", "suspended", "session_expired"] as const)(
      "账号 %s → 409 ACCOUNT_UNAVAILABLE",
      async (status) => {
        const { group } = await stageGroup();
        const member = await addMember(group, { status });
        const res = await app.inject({
          method: "POST",
          url: `/api/groups/${group.id}/send`,
          headers: admin,
          payload: { accountId: member.id, text: "x" },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          error: { code: "ACCOUNT_UNAVAILABLE", status },
        });
        expect(await getDb().message.count()).toBe(0);
      },
    );

    it("群不存在 → 404 GROUP_NOT_FOUND；群 unreachable → 409 GROUP_UNREACHABLE", async () => {
      const { group, creator } = await stageGroup();
      const missing = await app.inject({
        method: "POST",
        url: "/api/groups/nope/send",
        headers: admin,
        payload: { accountId: creator.id, text: "x" },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: { code: "GROUP_NOT_FOUND" },
      });

      await getDb().group.update({
        where: { id: group.id },
        data: { status: "unreachable" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: creator.id, text: "x" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "GROUP_UNREACHABLE", status: "unreachable" },
      });
    });

    it("viewer → 403 FORBIDDEN；未登录 → 401；形状错 → 400 VALIDATION_ERROR", async () => {
      const { group, creator } = await stageGroup();
      const forbidden = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: viewer,
        payload: { accountId: creator.id, text: "x" },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      const anon = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        payload: { accountId: creator.id, text: "x" },
      });
      expect(anon.statusCode).toBe(401);

      const bad = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: creator.id },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(await getDb().message.count()).toBe(0);
    });
  });

  // ---- S1：受理与发出 ---------------------------------------------------------------------

  describe("S1 受理与发出", () => {
    it("tick 后 accepted（网关恰好收到一次）；message_sent → sent，msgId / sentAt 改为网关的值；重复事件幂等", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator, "s1");

      const stats = await tick();
      expect(stats.claimed).toBe(1);
      expect(stats.outcomes.accepted).toBe(1);

      const accepted = await row(messageId);
      expect(accepted).toMatchObject({
        deliveryStatus: "accepted",
        attempts: 1,
        claimedBy: null,
        lockedAt: null,
        msgId: null,
      });
      expect(accepted.acceptedAt?.getTime()).toBe(clock.now().getTime());
      const attempts = await getDb().outboundAttempt.findMany({
        where: { messageId },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNo: 1,
        isResend: false,
        httpStatus: 202,
        errorCode: null,
      });
      expect(attempts[0]!.finishedAt).not.toBeNull();

      const sim = await simState();
      expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [clientMsgId, 202],
      ]);
      expect(sim.messages).toHaveLength(1);
      const landed = sim.messages[0]!;

      // #8 收到 message_sent 后调这里
      const applied = await deliverGatewayReceipt(
        { clientMsgId, msgId: landed.msgId, sentAt: landed.sentAt },
        { clock, log: silent },
      );
      expect(applied).toEqual({ applied: true, status: "sent" });
      const sent = await row(messageId);
      expect(sent).toMatchObject({
        deliveryStatus: "sent",
        msgId: landed.msgId,
        failCode: null,
      });
      expect(sent.sentAt.toISOString()).toBe(landed.sentAt);

      const events = await messageEvents();
      expect(events.map((e) => e.deliveryStatus)).toEqual([
        "queued",
        "accepted",
        "sent",
      ]);
      expect(events[2]).toMatchObject({ msgId: landed.msgId, clientMsgId });

      // 重复的 message_sent：不改、不再发事件
      const again = await deliverGatewayReceipt(
        { clientMsgId, msgId: landed.msgId, sentAt: landed.sentAt },
        { clock, log: silent },
      );
      expect(again).toEqual({ applied: false, status: "sent" });
      expect(await messageEvents()).toHaveLength(3);
    });

    it("message 事件先于 message_sent 到（#8 已插回流行）：记 sent 时合并，一条消息只剩一行", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator, "echo");
      await tick();
      const landed = (await simState()).messages[0]!;
      // #8 在 message_sent 之前收到 message 事件时会插一行回流行（clientMsgId 为 null）
      await getDb().message.create({
        data: {
          groupId: group.id,
          msgId: landed.msgId,
          senderPlatformUserId: creator.platformUserId!,
          isOwn: true,
          text: "echo",
          sentAt: new Date(landed.sentAt),
        },
      });

      await deliverGatewayReceipt(
        { clientMsgId, msgId: landed.msgId, sentAt: new Date(landed.sentAt) },
        { clock, log: silent },
      );
      const rows = await getDb().message.findMany({
        where: { groupId: group.id, msgId: landed.msgId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: messageId,
        clientMsgId,
        deliveryStatus: "sent",
      });
    });

    it("不认识的 clientMsgId：applied = false，不写任何东西", async () => {
      const r = await deliverGatewayReceipt(
        { clientMsgId: randomUUID(), msgId: "m", sentAt: clock.now() },
        { clock, log: silent },
      );
      expect(r).toEqual({ applied: false, status: null });
      expect(await getDb().wsEvent.count()).toBe(0);
    });
  });

  // ---- S4：限流 -------------------------------------------------------------------------

  describe("S4 限流", () => {
    it("429 → 账号 rate_limited；到期前网关收不到该账号的 send；到期后按原顺序发出；别的账号不受影响", async () => {
      const { group, creator: a } = await stageGroup();
      const b = await addMember(group);
      await scenario({
        send: {
          responses: [
            { status: 429, retryAfterSeconds: 5, match: { accountId: a.id } },
          ],
        },
      });
      const m1 = await enqueue(group, a, "a-1");
      clock.advance(1);
      const m2 = await enqueue(group, a, "a-2");
      clock.advance(1);
      const m3 = await enqueue(group, b, "b-1");

      // tick 1：a 的第一条 429（同账号一次只在途一条，所以 a-2 没被领）；b 的照常 202
      const s1 = await tick();
      expect(s1.claimed).toBe(2);
      expect(s1.outcomes).toMatchObject({ requeued: 1, accepted: 1 });
      const limitedAt = clock.now();
      const acc = await account(a.id);
      expect(acc.status).toBe("rate_limited");
      expect(acc.rateLimitedUntil?.getTime()).toBe(limitedAt.getTime() + 5_000);
      expect(await row(m1.messageId)).toMatchObject({
        deliveryStatus: "queued",
        claimedBy: null,
        attempts: 1,
      });
      expect((await row(m1.messageId)).nextAttemptAt?.getTime()).toBe(
        limitedAt.getTime() + 5_000,
      );
      expect((await row(m2.messageId)).deliveryStatus).toBe("queued");
      expect((await row(m3.messageId)).deliveryStatus).toBe("accepted");

      // 到期前：再怎么 tick，网关都收不到 a 的 send
      clock.advance(4_999);
      for (let i = 0; i < 3; i++) {
        const s = await tick();
        expect(s.claimed).toBe(0);
      }
      let calls = (await simState()).sendCalls;
      expect(calls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [m1.clientMsgId, 429],
        [m3.clientMsgId, 202],
      ]);

      // 到期：限流 worker 把账号恢复 online（这里直接调它的 service），出站 worker 按原顺序发出
      clock.advance(1);
      const recovered = await recoverRateLimited({ clock, log: silent });
      expect(recovered).toEqual({ due: 1, recovered: 1 });
      expect((await account(a.id)).status).toBe("online");

      const s2 = await tick();
      expect(s2.claimed).toBe(1);
      expect((await row(m1.messageId)).deliveryStatus).toBe("accepted");
      expect((await row(m2.messageId)).deliveryStatus).toBe("queued");
      const s3 = await tick();
      expect(s3.claimed).toBe(1);
      expect((await row(m2.messageId)).deliveryStatus).toBe("accepted");

      calls = (await simState()).sendCalls;
      expect(calls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [m1.clientMsgId, 429],
        [m3.clientMsgId, 202],
        [m1.clientMsgId, 202],
        [m2.clientMsgId, 202],
      ]);
      // 429 那次也记在 outbound_attempts 里
      expect(
        (
          await getDb().outboundAttempt.findMany({
            where: { messageId: m1.messageId },
            orderBy: { attemptNo: "asc" },
          })
        ).map((x) => [x.attemptNo, x.httpStatus, x.errorCode]),
      ).toEqual([
        [1, 429, "RATE_LIMITED"],
        [2, 202, null],
      ]);
    });

    it("账号先于排在前面的那条到点（两边截止差几毫秒）：后面的也等着，不插队", async () => {
      const { group, creator: a } = await stageGroup();
      await scenario({
        send: {
          responses: [
            { status: 429, retryAfterSeconds: 5, match: { accountId: a.id } },
          ],
        },
      });
      const m1 = await enqueue(group, a, "a-1");
      clock.advance(1);
      const m2 = await enqueue(group, a, "a-2");
      await tick();
      const limitedAt = clock.now();
      // 真实进程里 requeue 的排期与 enterRateLimited 的截止各自取时钟：让 a-1 比账号晚 50ms 到点
      await getDb().message.update({
        where: { id: m1.messageId },
        data: { nextAttemptAt: new Date(limitedAt.getTime() + 5_050) },
      });

      clock.advance(5_000);
      await recoverRateLimited({ clock, log: silent });
      expect((await account(a.id)).status).toBe("online");
      expect((await tick()).claimed).toBe(0);
      expect((await row(m2.messageId)).deliveryStatus).toBe("queued");

      clock.advance(50);
      await tick();
      await tick();
      expect(
        (await simState()).sendCalls.map((c) => [c.clientMsgId, c.status]),
      ).toEqual([
        [m1.clientMsgId, 429],
        [m1.clientMsgId, 202],
        [m2.clientMsgId, 202],
      ]);
    });

    it("限流期内即使账号状态还没被恢复，到期时刻一过就照常领取（不依赖限流 worker 的时序）", async () => {
      const { group, creator: a } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 429, retryAfterSeconds: 3 }] },
      });
      const m = await enqueue(group, a);
      await tick();
      expect((await account(a.id)).status).toBe("rate_limited");
      clock.advance(3_000);
      const s = await tick();
      expect(s.claimed).toBe(1);
      expect((await row(m.messageId)).deliveryStatus).toBe("accepted");
    });
  });

  // ---- 504 / unknown / by-client-id -------------------------------------------------------

  describe("504 NETWORK_TIMEOUT → unknown → by-client-id", () => {
    it("504 后消息其实已发出：by-client-id 200 → sent，不重发", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 504, landAfterMs: 0 }] },
      });
      const { clientMsgId, messageId } = await enqueue(group, creator);

      const s1 = await tick();
      expect(s1.outcomes.unknown).toBe(1);
      const unknown = await row(messageId);
      expect(unknown).toMatchObject({
        deliveryStatus: "unknown",
        claimedBy: null,
        attempts: 1,
      });
      expect(unknown.unknownSince?.getTime()).toBe(clock.now().getTime());

      await sleepMs(20); // 模拟器 landAfterMs: 0 的定时器
      expect((await simState()).messages).toHaveLength(1);

      const s2 = await tick();
      expect(s2.unknownChecked).toBe(1);
      expect(s2.claimed).toBe(0);
      const sent = await row(messageId);
      const landed = (await simState()).messages[0]!;
      expect(sent).toMatchObject({
        deliveryStatus: "sent",
        msgId: landed.msgId,
        resendCount: 0,
      });
      expect(sent.sentAt.toISOString()).toBe(landed.sentAt);
      expect((await simState()).sendCalls).toHaveLength(1);
      expect(
        (await messageEvents())
          .filter((e) => e.clientMsgId === clientMsgId)
          .map((e) => e.deliveryStatus),
      ).toEqual(["queued", "unknown", "sent"]);
    });

    it("504 后 404：2 秒内不重发；超过 2 秒确认没发出 → 同一 clientMsgId 重发一次 → 网关恰好一条", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 504, landAfterMs: null }] },
      });
      const { clientMsgId, messageId } = await enqueue(group, creator);
      await tick();
      expect((await row(messageId)).deliveryStatus).toBe("unknown");

      // 确认窗口内：查到 404 也不能重发
      clock.advance(CONFIRM_WINDOW_MS - 1);
      const early = await tick();
      expect(early.unknownChecked).toBe(1);
      expect(early.claimed).toBe(0);
      expect((await row(messageId)).deliveryStatus).toBe("unknown");
      expect((await simState()).sendCalls).toHaveLength(1);

      // 超过 2 秒：确认未发出 → 回 queued（resendCount = 1）→ 同一 tick 领取重发 → 202
      clock.advance(2);
      const late = await tick();
      expect(late.claimed).toBe(1);
      expect(late.outcomes.accepted).toBe(1);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        resendCount: 1,
        attempts: 2,
        unknownSince: null,
      });
      await sleepMs(20);
      const sim = await simState();
      expect(sim.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [clientMsgId, 504],
        [clientMsgId, 202],
      ]);
      expect(sim.messages).toHaveLength(1);
      expect(
        (
          await getDb().outboundAttempt.findMany({
            where: { messageId },
            orderBy: { attemptNo: "asc" },
          })
        ).map((x) => [x.attemptNo, x.isResend, x.httpStatus, x.errorCode]),
      ).toEqual([
        [1, false, 504, "NETWORK_TIMEOUT"],
        [2, true, 202, null],
      ]);
    });

    it("by-client-id 在 2 秒内发出、2 秒后才回 404：这个 404 不算确认，不重发", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 504, landAfterMs: null }] },
      });
      const { messageId } = await enqueue(group, creator);
      await tick();

      // 查询在第 1.8 秒发出、响应在第 2.2 秒回来：404 反映的是 1.8 秒时的状态，消息可能在那之后才落地
      const slowLookup: GatewayClient = {
        ...gatewayClient,
        async getMessageByClientId(groupId, clientMsgId) {
          const landing = await gatewayClient.getMessageByClientId(
            groupId,
            clientMsgId,
          );
          clock.advance(400);
          return landing;
        },
      };
      clock.advance(CONFIRM_WINDOW_MS - 200);
      const s = await runOutboxTick({
        clock,
        gateway: slowLookup,
        workerId: "w1",
        log: silent,
      });
      expect(s.unknownChecked).toBe(1);
      expect(s.claimed).toBe(0);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "unknown",
        resendCount: 0,
      });
      expect((await simState()).sendCalls).toHaveLength(1);

      // 下一次查询在窗口之后发出：这次的 404 才是确认
      const late = await tick();
      expect(late.claimed).toBe(1);
      expect((await row(messageId)).resendCount).toBe(1);
    });

    it("重发后仍 504 + 404 → failed NETWORK_TIMEOUT，总共只重发一次", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: {
          responses: [
            { status: 504, landAfterMs: null },
            { status: 504, landAfterMs: null },
          ],
        },
      });
      const { clientMsgId, messageId } = await enqueue(group, creator);
      await tick();
      clock.advance(CONFIRM_WINDOW_MS + 1);
      const resend = await tick();
      expect(resend.outcomes.unknown).toBe(1);
      expect((await row(messageId)).resendCount).toBe(1);
      clock.advance(CONFIRM_WINDOW_MS + 1);
      const final = await tick();
      expect(final.claimed).toBe(0);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "NETWORK_TIMEOUT",
        resendCount: 1,
        attempts: 2,
      });
      const sim = await simState();
      expect(sim.sendCalls.map((c) => c.clientMsgId)).toEqual([
        clientMsgId,
        clientMsgId,
      ]);
      expect(sim.messages).toHaveLength(0);
      // 再多 tick 也不会有第三次
      clock.advance(60_000);
      await tick();
      expect((await simState()).sendCalls).toHaveLength(2);
    });

    it("by-client-id 不可用（503）期间保持 unknown；恢复后 2 秒窗口已过 → 立刻定态", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 504, landAfterMs: null }] },
      });
      const { messageId } = await enqueue(group, creator);
      await tick();
      await scenario({ outage: { routes: ["by-client-id"] } });

      clock.advance(CONFIRM_WINDOW_MS + 1);
      for (let i = 0; i < 3; i++) {
        const s = await tick();
        expect(s.claimed).toBe(0);
        expect((await row(messageId)).deliveryStatus).toBe("unknown");
      }
      expect((await simState()).sendCalls).toHaveLength(1);

      await scenario({ outage: { routes: [] } });
      const s = await tick();
      expect(s.claimed).toBe(1);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        resendCount: 1,
      });
    });
  });

  // ---- 网关同步错误表（A2）------------------------------------------------------------------

  describe("A2 错误表", () => {
    it("GROUP_WRITE_FORBIDDEN → 该条 failed；群 unreachable；序列运行 stopped；该群其余 queued → cancelled GROUP_UNREACHABLE；账号不变", async () => {
      const { group, creator } = await stageGroup();
      const other = await stageGroup();
      await scenario({
        send: {
          responses: [
            {
              status: 403,
              code: "GROUP_WRITE_FORBIDDEN",
              match: { accountId: creator.id },
            },
          ],
        },
      });
      const db = getDb();
      const sequence = await db.sequence.create({
        data: { name: "seq", steps: [] },
      });
      const run = await db.sequenceRun.create({
        data: {
          sequenceId: sequence.id,
          groupId: group.id,
          vars: {},
          stepVars: {},
          currentStepIndex: 2,
        },
      });
      const m1 = await enqueue(group, creator, "first");
      clock.advance(1);
      const m2 = await enqueue(group, creator, "second");
      const m3 = await enqueue(other.group, other.creator, "elsewhere");

      const s = await tick();
      expect(s.outcomes).toMatchObject({ failed: 1, accepted: 1 });
      expect(await row(m1.messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "GROUP_WRITE_FORBIDDEN",
      });
      expect(await row(m2.messageId)).toMatchObject({
        deliveryStatus: "cancelled",
        failCode: "GROUP_UNREACHABLE",
      });
      expect((await row(m3.messageId)).deliveryStatus).toBe("accepted");
      expect(
        (await db.group.findUniqueOrThrow({ where: { id: group.id } })).status,
      ).toBe("unreachable");
      expect(
        (await db.group.findUniqueOrThrow({ where: { id: other.group.id } }))
          .status,
      ).toBe("active");
      const stopped = await db.sequenceRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(stopped.status).toBe("stopped");
      expect(stopped.finishedAt?.getTime()).toBe(clock.now().getTime());
      expect((await account(creator.id)).status).toBe("online");

      const events = await db.wsEvent.findMany({ orderBy: { id: "asc" } });
      expect(
        events.filter((e) => e.type === "sequence_run").map((e) => e.payload),
      ).toEqual([
        {
          runId: run.id,
          groupId: group.id,
          status: "stopped",
          currentStepIndex: 2,
        },
      ]);
      expect(
        events
          .filter((e) => e.type === "group_status_changed")
          .map((e) => e.payload),
      ).toEqual([
        {
          groupId: group.id,
          from: "active",
          to: "unreachable",
          reason: "GROUP_WRITE_FORBIDDEN",
        },
      ]);
      // 之后该群不再受理
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/send`,
        headers: admin,
        payload: { accountId: creator.id, text: "x" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "GROUP_UNREACHABLE" },
      });
      // 网关只收到过 m1（m2 没发就被取消）+ m3
      expect((await simState()).sendCalls.map((c) => c.clientMsgId)).toEqual([
        m1.clientMsgId,
        m3.clientMsgId,
      ]);
    });

    it("进终态中途出错（级联里库抛错）：账号、这条消息、投递记录一起回滚 —— 不会出现「该条已 cancelled、账号还 online」", async () => {
      const { group } = await stageGroup();
      const victim = await addMember(group);
      await scenario({
        send: {
          responses: [
            {
              status: 403,
              code: "ACCOUNT_SUSPENDED",
              match: { accountId: victim.id },
            },
          ],
        },
      });
      const m1 = await enqueue(group, victim, "v-1");
      // 注入故障：账号一改成 suspended 就抛（模拟级联事务里的库错误）
      const s1 = await withFailingUpdates(
        "accounts",
        "NEW.status = 'suspended'",
        () => tick(),
      );
      expect(s1.outcomes.cancelled).toBe(0);
      expect((await account(victim.id)).status).toBe("online");
      expect(await row(m1.messageId)).toMatchObject({
        deliveryStatus: "queued",
        failCode: null,
      });
      expect(
        await getDb().outboundAttempt.count({
          where: { messageId: m1.messageId, finishedAt: { not: null } },
        }),
      ).toBe(0);
    });

    it("SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE → 该条 failed（同名 failCode）；账号、群状态不变；不重试", async () => {
      const { group } = await stageGroup();
      const notInGroup = await addMember(group, { gatewayMember: false });
      const offline = await addMember(group, { connected: false });
      const m1 = await enqueue(group, notInGroup);
      const m2 = await enqueue(group, offline);

      const s = await tick();
      expect(s.outcomes.failed).toBe(2);
      expect(await row(m1.messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "SENDER_NOT_IN_GROUP",
        claimedBy: null,
      });
      expect(await row(m2.messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "ACCOUNT_OFFLINE",
      });
      expect((await account(notInGroup.id)).status).toBe("online");
      expect((await account(offline.id)).status).toBe("online");
      expect(
        (await getDb().group.findUniqueOrThrow({ where: { id: group.id } }))
          .status,
      ).toBe("active");
      await tick();
      expect((await simState()).sendCalls).toHaveLength(2);
      expect(
        (await messageEvents()).filter((e) => e.deliveryStatus === "failed"),
      ).toHaveLength(2);
    });

    it.each([
      {
        status: 403 as const,
        code: "ACCOUNT_SUSPENDED",
        terminal: "suspended",
      },
      {
        status: 401 as const,
        code: "SESSION_EXPIRED",
        terminal: "session_expired",
      },
    ])(
      "$code → 账号 $terminal 级联（一个事务）：该条与其余 queued 一样 cancelled ACCOUNT_TERMINAL（网关码留在 lastError / 投递记录）、移出群",
      async ({ status, code, terminal }) => {
        const { group, creator } = await stageGroup();
        const victim = await addMember(group);
        await scenario({
          send: {
            responses: [
              {
                status,
                ...(status === 403 ? { code } : {}),
                match: { accountId: victim.id },
              },
            ],
          },
        });
        const m1 = await enqueue(group, victim, "v-1");
        clock.advance(1);
        const m2 = await enqueue(group, victim, "v-2");
        const m3 = await enqueue(group, creator, "c-1");

        const s = await tick();
        expect(s.outcomes).toMatchObject({ cancelled: 1, accepted: 1 });
        // A1：无论从哪个来源进终态结果都一样 —— 触发的这条也是「排队中的发送」
        expect(await row(m1.messageId)).toMatchObject({
          deliveryStatus: "cancelled",
          failCode: "ACCOUNT_TERMINAL",
          lastError: code,
          claimedBy: null,
        });
        expect(
          (
            await getDb().outboundAttempt.findMany({
              where: { messageId: m1.messageId },
            })
          ).map((a) => [a.httpStatus, a.errorCode]),
        ).toEqual([[status, code]]);
        expect(await row(m2.messageId)).toMatchObject({
          deliveryStatus: "cancelled",
          failCode: "ACCOUNT_TERMINAL",
        });
        expect((await row(m3.messageId)).deliveryStatus).toBe("accepted");
        expect((await account(victim.id)).status).toBe(terminal);
        expect(
          await getDb().groupMember.count({ where: { accountId: victim.id } }),
        ).toBe(0);
        expect(
          (
            await getDb().wsEvent.findMany({
              where: { type: "account_terminal" },
            })
          ).map((e) => e.payload),
        ).toEqual([{ accountId: victim.id, status: terminal }]);
        // 网关只收到 victim 的第一条与 creator 的
        expect((await simState()).sendCalls.map((c) => c.clientMsgId)).toEqual([
          m1.clientMsgId,
          m3.clientMsgId,
        ]);
      },
    );

    it("message_failed 事件：GROUP_WRITE_FORBIDDEN → failed + 群 unreachable；ACCOUNT_SUSPENDED → failed + 账号终态", async () => {
      const { group, creator } = await stageGroup();
      const other = await stageGroup();
      const m1 = await enqueue(group, creator);
      const m2 = await enqueue(other.group, other.creator);
      await tick();
      expect((await row(m1.messageId)).deliveryStatus).toBe("accepted");

      const r1 = await deliverGatewayReceipt(
        { clientMsgId: m1.clientMsgId, code: "GROUP_WRITE_FORBIDDEN" },
        { clock, log: silent },
      );
      expect(r1).toEqual({ applied: true, status: "failed" });
      expect(await row(m1.messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "GROUP_WRITE_FORBIDDEN",
      });
      expect(
        (await getDb().group.findUniqueOrThrow({ where: { id: group.id } }))
          .status,
      ).toBe("unreachable");
      expect((await account(creator.id)).status).toBe("online");

      const r2 = await deliverGatewayReceipt(
        { clientMsgId: m2.clientMsgId, code: "ACCOUNT_SUSPENDED" },
        { clock, log: silent },
      );
      expect(r2).toEqual({ applied: true, status: "failed" });
      expect(await row(m2.messageId)).toMatchObject({
        deliveryStatus: "failed",
        failCode: "ACCOUNT_SUSPENDED",
      });
      expect((await account(other.creator.id)).status).toBe("suspended");

      // 重复的 message_failed：不改
      const dup = await deliverGatewayReceipt(
        { clientMsgId: m2.clientMsgId, code: "ACCOUNT_SUSPENDED" },
        { clock, log: silent },
      );
      expect(dup).toEqual({ applied: false, status: "failed" });
    });

    it("网关整体 503 → 回 queued 有界退避（nextAttemptAt 在未来），到点再发；不算 failed", async () => {
      const { group, creator } = await stageGroup();
      const { messageId } = await enqueue(group, creator);
      await scenario({ outage: { all: true } });

      const s1 = await tick();
      expect(s1.outcomes.requeued).toBe(1);
      const queued = await row(messageId);
      expect(queued).toMatchObject({
        deliveryStatus: "queued",
        attempts: 1,
        claimedBy: null,
        lastError: "SERVICE_UNAVAILABLE",
      });
      const now = clock.now().getTime();
      expect(queued.nextAttemptAt!.getTime()).toBeGreaterThan(now);
      expect(queued.nextAttemptAt!.getTime()).toBeLessThanOrEqual(now + 2_000);

      // 没到点：不领
      const s2 = await tick();
      expect(s2.claimed).toBe(0);

      await scenario({ outage: { all: false } });
      clock.advance(2_000);
      const s3 = await tick();
      expect(s3.outcomes.accepted).toBe(1);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        attempts: 2,
      });
    });
  });

  // ---- 领取顺序 / 回收 ---------------------------------------------------------------------

  describe("领取与回收", () => {
    it("领取后被别的副本按过期回收（→ unknown）：原 worker 调网关前发现领取已丢，不发；确认未发出后只重发一次", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator);
      const [snapshot] = await claimBatch("w1", clock.now(), 10);
      expect(snapshot).toBeDefined();
      // w1 卡住（一批里前面的慢请求）超过回收阈值：w2 把它回收成 unknown
      clock.advance(STALE_CLAIM_MS + 1);
      const w2 = { clock, gateway: gatewayClient, workerId: "w2", log: silent };
      expect((await runConfirmTick(w2)).recovered).toBe(1);
      expect((await row(messageId)).deliveryStatus).toBe("unknown");
      // w1 终于轮到它：按领取时的快照照发就是第二条 —— 现在调网关前先续约，发现不在手上就不发
      const outcome = await dispatchOne(snapshot!, {
        clock,
        gateway: gatewayClient,
        workerId: "w1",
        log: silent,
      });
      expect(outcome).toBe("lost");
      expect((await simState()).sendCalls).toHaveLength(0);
      // w2 确认没发出（404 满 2 秒）后重发一次：网关恰好一条
      clock.advance(CONFIRM_WINDOW_MS + 1);
      await tick("w2");
      expect(
        (await simState()).sendCalls.map((c) => [c.clientMsgId, c.status]),
      ).toEqual([[clientMsgId, 202]]);
    });

    it("一批里的不同账号并发派发：一个账号的慢 send 不挡别的账号", async () => {
      const { group, creator } = await stageGroup();
      const other = await addMember(group);
      await enqueue(group, creator, "c-1");
      await enqueue(group, other, "o-1");
      // 第一个 send 要等第二个 send 也开始了才放行：串行派发会一直等下去
      let started = 0;
      let bothStarted!: () => void;
      const barrier = new Promise<void>((resolve) => {
        bothStarted = resolve;
      });
      const gated: GatewayClient = {
        ...gatewayClient,
        async send(input) {
          started += 1;
          if (started === 2) bothStarted();
          // 串行派发时第一个 send 永远等不到第二个开始：用例超时变红
          await barrier;
          return gatewayClient.send(input);
        },
      };
      const stats = await runDispatchTick({
        clock,
        gateway: gated,
        workerId: "w1",
        log: silent,
      });
      expect(stats.claimed).toBe(2);
      expect(stats.outcomes.accepted).toBe(2);
    });

    it("入队与终态级联互斥：级联进行中入队要等它提交，读到终态就拒绝 —— 不留终态账号的 queued", async () => {
      const { group } = await stageGroup();
      const victim = await addMember(group);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      // 进终态的事务先锁住账号行、停在中途
      const cascade = getDb().$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${victim.id} FOR UPDATE`;
          markLocked();
          await gate;
          await enterTerminalInTx(
            tx,
            victim.id,
            "suspended",
            "operator",
            clock.now(),
          );
        },
        { timeout: 10_000 },
      );
      await locked;
      const enqueued = enqueue(group, victim, "racing").then(
        () => "enqueued",
        (err: { code?: string }) => err.code,
      );
      await sleepMs(100);
      release();
      await cascade;
      expect(await enqueued).toBe("ACCOUNT_UNAVAILABLE");
      expect(
        await getDb().message.count({
          where: { accountId: victim.id, deliveryStatus: "queued" },
        }),
      ).toBe(0);
    });

    it("同账号有一条 unknown 时后面的不领：确认没发出后先重发它、再发后面的（顺序不乱）", async () => {
      const { group, creator } = await stageGroup();
      await scenario({
        send: { responses: [{ status: 504, landAfterMs: null }] },
      });
      const m1 = await enqueue(group, creator, "m1");
      clock.advance(1);
      const m2 = await enqueue(group, creator, "m2");
      await tick(); // m1 → 504 → unknown
      expect((await row(m1.messageId)).deliveryStatus).toBe("unknown");
      const blocked = await tick();
      expect(blocked.claimed).toBe(0);
      expect((await row(m2.messageId)).deliveryStatus).toBe("queued");

      clock.advance(CONFIRM_WINDOW_MS + 1);
      await tick(); // 确认没发出 → m1 回 queued 并重发
      await tick(); // 然后才轮到 m2
      expect((await simState()).sendCalls.map((c) => c.clientMsgId)).toEqual([
        m1.clientMsgId,
        m1.clientMsgId,
        m2.clientMsgId,
      ]);
    });

    it("同一账号同一时刻只在途一条（顺序发出）；不同账号同一 tick 各发各的", async () => {
      const { group, creator: a } = await stageGroup();
      const b = await addMember(group);
      const a1 = await enqueue(group, a, "a-1");
      clock.advance(1);
      const b1 = await enqueue(group, b, "b-1");
      clock.advance(1);
      const a2 = await enqueue(group, a, "a-2");

      const s1 = await tick();
      expect(s1.claimed).toBe(2);
      expect((await row(a1.messageId)).deliveryStatus).toBe("accepted");
      expect((await row(b1.messageId)).deliveryStatus).toBe("accepted");
      expect((await row(a2.messageId)).deliveryStatus).toBe("queued");
      const s2 = await tick();
      expect(s2.claimed).toBe(1);
      expect((await row(a2.messageId)).deliveryStatus).toBe("accepted");
      expect((await simState()).sendCalls.map((c) => c.clientMsgId)).toEqual([
        a1.clientMsgId,
        b1.clientMsgId,
        a2.clientMsgId,
      ]);
    });

    it("在途的一条挡住同账号的下一条：领取者没记账时 a-2 不会被领", async () => {
      const { group, creator: a } = await stageGroup();
      const a1 = await enqueue(group, a, "a-1");
      clock.advance(1);
      const a2 = await enqueue(group, a, "a-2");
      // 只领不发（模拟领取者正在调网关）
      const claimed = await claimBatch("dead-worker", clock.now(), 10);
      expect(claimed.map((c) => c.id)).toEqual([a1.messageId]);

      const s = await tick();
      expect(s.claimed).toBe(0);
      expect((await row(a2.messageId)).deliveryStatus).toBe("queued");
      expect((await simState()).sendCalls).toHaveLength(0);
    });

    it("领取者死了（lockedAt 过旧）：回收成 unknown 走确认，不直接重发；确认未发出后才重发，网关恰好一条", async () => {
      const { group, creator } = await stageGroup();
      const { clientMsgId, messageId } = await enqueue(group, creator);
      const claimed = await claimBatch("dead-worker", clock.now(), 10);
      expect(claimed).toHaveLength(1);
      expect(await row(messageId)).toMatchObject({
        claimedBy: "dead-worker",
        attempts: 1,
      });

      // 阈值内：不动它
      clock.advance(10_000);
      let s = await tick();
      expect(s.recovered).toBe(0);
      expect((await row(messageId)).claimedBy).toBe("dead-worker");

      clock.advance(30_000);
      s = await tick();
      expect(s.recovered).toBe(1);
      expect(s.claimed).toBe(0);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "unknown",
        claimedBy: null,
      });
      expect((await simState()).sendCalls).toHaveLength(0);

      clock.advance(CONFIRM_WINDOW_MS + 1);
      s = await tick();
      expect(s.outcomes.accepted).toBe(1);
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "accepted",
        resendCount: 1,
        attempts: 2,
      });
      expect((await simState()).sendCalls.map((c) => c.clientMsgId)).toEqual([
        clientMsgId,
      ]);
      // 死掉那次的 outbound_attempts 行以 CLAIM_LOST 收口（没有响应），新的一行记 202
      expect(
        (
          await getDb().outboundAttempt.findMany({
            where: { messageId },
            orderBy: { attemptNo: "asc" },
          })
        ).map((x) => [x.attemptNo, x.httpStatus, x.errorCode]),
      ).toEqual([
        [1, null, "CLAIM_LOST"],
        [2, 202, null],
      ]);
    });

    it("级联在途中把行置 cancelled（领取之后、调网关之前）：不再发，释放领取标记、投递记录收尾", async () => {
      const { group, creator } = await stageGroup();
      const { messageId } = await enqueue(group, creator);
      const claimed = await claimBatch("w1", clock.now(), 10);
      expect(claimed).toHaveLength(1);
      // 模拟账号在途中进终态：级联把 queued 行置 cancelled
      await getDb().message.update({
        where: { id: messageId },
        data: { deliveryStatus: "cancelled", failCode: "ACCOUNT_TERMINAL" },
      });
      const { dispatchOne } = await import("../src/services/outbox-service.js");
      const outcome = await dispatchOne(claimed[0]!, {
        clock,
        gateway: gatewayClient,
        workerId: "w1",
        log: silent,
      });
      expect(outcome).toBe("lost");
      expect(await row(messageId)).toMatchObject({
        deliveryStatus: "cancelled",
        failCode: "ACCOUNT_TERMINAL",
        claimedBy: null,
        lockedAt: null,
      });
      expect((await simState()).sendCalls).toHaveLength(0);
      expect(
        (await getDb().outboundAttempt.findMany({ where: { messageId } })).map(
          (a) => [a.errorCode, a.finishedAt !== null],
        ),
      ).toEqual([["NOT_DISPATCHED", true]]);
    });
  });
});
