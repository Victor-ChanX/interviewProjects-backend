// 消息网关模拟器（src/sim/gateway）自带用例：逐条对照题目 2.1 的接口与时序契约。
// 时间：vi.useFakeTimers 只假 setTimeout / Date（Fastify inject 不依赖它们），延时全部用 advanceTimersByTimeAsync 推进，
// 不真 sleep。SSE 一节要真 socket（reply.raw 写流），用 listen(0) + fetch，真定时器，场景延时设为 0 / 很小。
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildGatewayApp } from "../src/sim/gateway/app.js";

type Json = Record<string, unknown>;
type Method = "GET" | "POST";

// expect.any / stringMatching 返回 any；收成 unknown 再放进 toEqual / toMatchObject 的期望对象里。
const anyString: unknown = expect.any(String);
const mediaPath: unknown = expect.stringMatching(/^\/media\//);

async function call(
  app: FastifyInstance,
  method: Method,
  url: string,
  payload?: Json,
): Promise<{ status: number; body: Json }> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json<Json>() };
}

const scenario = (app: FastifyInstance, patch: Json) =>
  call(app, "POST", "/_sim/scenario", patch);

/**
 * 让一个刚发起的 inject 真正跑进 handler：light-my-request 经几次 nextTick / setImmediate 才到路由，
 * 而假定时器只假 setTimeout，所以先让出几轮宏任务，再推进假时间，handler 里的 sleep 才已经登记。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface State {
  messages: { msgId: string; clientMsgId: string | null; sentAt: string }[];
  sendCalls: { clientMsgId: string; status: number; code: string | null }[];
  events: {
    count: number;
    lastEventId: number;
    byType: Record<string, number>;
    items: { eventId: number; type: string; data: Json }[];
  };
  groups: { groupId: string; ownerLeft: boolean; members: Json[] }[];
  streams: { open: number };
}

async function state(app: FastifyInstance): Promise<State> {
  const res = await app.inject({ method: "GET", url: "/_sim/state" });
  return res.json<State>();
}

const eventsOf = (s: State, type: string) =>
  s.events.items.filter((e) => e.type === type);

/** 常用布景：a1 建群（群主），a2 通过邀请入群（join 延时 0，推进 1ms 让 member_joined 落地）。 */
async function setupGroup(app: FastifyInstance): Promise<{
  groupId: string;
  ownerPu: string;
  memberPu: string;
}> {
  await scenario(app, {
    join: { delayMs: 0 },
    send: { eventDelayMs: 0 },
    kick: { responseDelayMs: 0 },
  });
  const a1 = await call(app, "POST", "/accounts/a1/connect");
  const a2 = await call(app, "POST", "/accounts/a2/connect");
  const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
  const groupId = g.body.groupId as string;
  const inv = await call(app, "POST", `/groups/${groupId}/invite`);
  const joined = await call(app, "POST", `/groups/${groupId}/join`, {
    accountId: "a2",
    inviteLink: inv.body.inviteLink,
  });
  expect(joined.status).toBe(202);
  await vi.advanceTimersByTimeAsync(1);
  return {
    groupId,
    ownerPu: a1.body.platformUserId as string,
    memberPu: a2.body.platformUserId as string,
  };
}

const sendMsg = (
  app: FastifyInstance,
  groupId: string,
  accountId: string,
  clientMsgId: string,
) =>
  call(app, "POST", `/groups/${groupId}/send`, {
    accountId,
    clientMsgId,
    text: `text-${clientMsgId}`,
  });

describe("网关模拟器：HTTP 契约（假定时器）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildGatewayApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await call(app, "POST", "/_sim/reset");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("账号", () => {
    it("connect 幂等：同一 accountId 每次拿到同一个 platformUserId；不同账号不同", async () => {
      const first = await call(app, "POST", "/accounts/acc-1/connect");
      const second = await call(app, "POST", "/accounts/acc-1/connect");
      const other = await call(app, "POST", "/accounts/acc-2/connect");
      expect(first.status).toBe(200);
      expect(typeof first.body.platformUserId).toBe("string");
      expect(second.body.platformUserId).toBe(first.body.platformUserId);
      expect(other.body.platformUserId).not.toBe(first.body.platformUserId);
    });

    it("disconnect 后 send / join / promote / kick / leave 全部 409 ACCOUNT_OFFLINE", async () => {
      const { groupId, memberPu } = await setupGroup(app);
      expect((await call(app, "POST", "/accounts/a2/disconnect")).status).toBe(
        200,
      );
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);

      const attempts = [
        sendMsg(app, groupId, "a2", "c-off"),
        call(app, "POST", `/groups/${groupId}/join`, {
          accountId: "a2",
          inviteLink: inv.body.inviteLink,
        }),
        call(app, "POST", `/groups/${groupId}/promote`, {
          byAccountId: "a2",
          accountId: "a1",
        }),
        call(app, "POST", `/groups/${groupId}/kick`, {
          byAccountId: "a2",
          targetPlatformUserId: memberPu,
        }),
        call(app, "POST", `/groups/${groupId}/leave`, { accountId: "a2" }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("ACCOUNT_OFFLINE");
      }
      // 未 connect 过的账号建群同样离线
      const g = await call(app, "POST", "/groups", {
        creatorAccountId: "nobody",
      });
      expect(g.status).toBe(409);
    });

    it("手动推 account_status: suspended → 移出所有群并推 member_left，之后 connect 也 403", async () => {
      const { groupId, memberPu } = await setupGroup(app);
      const pushed = await call(app, "POST", "/_sim/push", {
        kind: "account_status",
        accountId: "a2",
        status: "suspended",
      });
      expect(pushed.status).toBe(200);
      expect((pushed.body.eventIds as number[]).length).toBe(2);

      const members = await call(app, "GET", `/groups/${groupId}/members`);
      expect(members.body).toEqual([{ platformUserId: anyString }]);
      expect(members.body).not.toContainEqual({ platformUserId: memberPu });

      const s = await state(app);
      expect(eventsOf(s, "account_status")[0]?.data).toMatchObject({
        accountId: "a2",
        status: "suspended",
      });
      expect(eventsOf(s, "member_left")[0]?.data).toMatchObject({
        groupId,
        platformUserId: memberPu,
      });

      const reconnect = await call(app, "POST", "/accounts/a2/connect");
      expect(reconnect.status).toBe(403);
      expect(reconnect.body.code).toBe("ACCOUNT_SUSPENDED");
    });
  });

  describe("邀请与 join", () => {
    it("readyAfterMs 内 409 INVITE_NOT_READY，到点后 202；member_joined 延迟后才到，成员列表先变", async () => {
      await scenario(app, {
        invite: { readyAfterMs: 3000 },
        join: { delayMs: 500 },
      });
      await call(app, "POST", "/accounts/a1/connect");
      const a2 = await call(app, "POST", "/accounts/a2/connect");
      const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
      const groupId = g.body.groupId as string;
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      expect(inv.body.readyAfterMs).toBe(3000);
      const joinBody = { accountId: "a2", inviteLink: inv.body.inviteLink };

      const early = await call(
        app,
        "POST",
        `/groups/${groupId}/join`,
        joinBody,
      );
      expect(early.status).toBe(409);
      expect(early.body.code).toBe("INVITE_NOT_READY");

      await vi.advanceTimersByTimeAsync(3000);
      const accepted = await call(
        app,
        "POST",
        `/groups/${groupId}/join`,
        joinBody,
      );
      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({ accepted: true });

      // 受理后、member_joined 之前：不是成员
      await vi.advanceTimersByTimeAsync(400);
      let members = await call(app, "GET", `/groups/${groupId}/members`);
      expect(members.body).toHaveLength(1);
      expect((await state(app)).events.count).toBe(0);

      await vi.advanceTimersByTimeAsync(100);
      members = await call(app, "GET", `/groups/${groupId}/members`);
      expect(members.body).toHaveLength(2);
      const s = await state(app);
      expect(s.events.items).toEqual([
        {
          eventId: 1,
          type: "member_joined",
          data: {
            eventId: 1,
            type: "member_joined",
            groupId,
            platformUserId: a2.body.platformUserId,
          },
        },
      ]);
    });

    it("链接过期 410 INVITE_EXPIRED（自然过期与 /_sim/invites/expire）；重新申请即可", async () => {
      await scenario(app, {
        invite: { expiresAfterMs: 1000 },
        join: { delayMs: 0 },
      });
      await call(app, "POST", "/accounts/a1/connect");
      await call(app, "POST", "/accounts/a2/connect");
      const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
      const groupId = g.body.groupId as string;

      const inv1 = await call(app, "POST", `/groups/${groupId}/invite`);
      await vi.advanceTimersByTimeAsync(1000);
      const expired = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a2",
        inviteLink: inv1.body.inviteLink,
      });
      expect(expired.status).toBe(410);
      expect(expired.body.code).toBe("INVITE_EXPIRED");

      const inv2 = await call(app, "POST", `/groups/${groupId}/invite`);
      await call(app, "POST", "/_sim/invites/expire", {
        inviteLink: inv2.body.inviteLink,
      });
      const forced = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a2",
        inviteLink: inv2.body.inviteLink,
      });
      expect(forced.status).toBe(410);

      const inv3 = await call(app, "POST", `/groups/${groupId}/invite`);
      const ok = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a2",
        inviteLink: inv3.body.inviteLink,
      });
      expect(ok.status).toBe(202);
    });

    it("已在群里再 join → 409 ALREADY_MEMBER 且不再推 member_joined", async () => {
      const { groupId } = await setupGroup(app);
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      const again = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a2",
        inviteLink: inv.body.inviteLink,
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("ALREADY_MEMBER");
      await vi.advanceTimersByTimeAsync(5000);
      expect((await state(app)).events.byType).toEqual({ member_joined: 1 });
    });

    it("场景 neverJoin：202 之后 member_joined 永远不来，账号并未入群", async () => {
      await scenario(app, { join: { neverJoin: true } });
      await call(app, "POST", "/accounts/a1/connect");
      await call(app, "POST", "/accounts/a3/connect");
      const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
      const groupId = g.body.groupId as string;
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      const res = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a3",
        inviteLink: inv.body.inviteLink,
      });
      expect(res.status).toBe(202);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toHaveLength(1);
      expect((await state(app)).events.count).toBe(0);
      // 未入群的账号 send → SENDER_NOT_IN_GROUP
      const sent = await sendMsg(app, groupId, "a3", "c-nj");
      expect(sent.status).toBe(403);
      expect(sent.body.code).toBe("SENDER_NOT_IN_GROUP");
    });
  });

  describe("promote / kick / leave", () => {
    it("promote：非群主 403 NO_PERMISSION；member_joined 之前 409 NOT_MEMBER_YET；成功 200 {} 且不推事件", async () => {
      await scenario(app, { join: { delayMs: 1000 } });
      await call(app, "POST", "/accounts/a1/connect");
      await call(app, "POST", "/accounts/a2/connect");
      const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
      const groupId = g.body.groupId as string;
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a2",
        inviteLink: inv.body.inviteLink,
      });

      const notYet = await call(app, "POST", `/groups/${groupId}/promote`, {
        byAccountId: "a1",
        accountId: "a2",
      });
      expect(notYet.status).toBe(409);
      expect(notYet.body.code).toBe("NOT_MEMBER_YET");

      await vi.advanceTimersByTimeAsync(1000);
      const byMember = await call(app, "POST", `/groups/${groupId}/promote`, {
        byAccountId: "a2",
        accountId: "a1",
      });
      expect(byMember.status).toBe(403);
      expect(byMember.body.code).toBe("NO_PERMISSION");

      const eventsBefore = (await state(app)).events.count;
      const ok = await call(app, "POST", `/groups/${groupId}/promote`, {
        byAccountId: "a1",
        accountId: "a2",
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({});
      expect((await state(app)).events.count).toBe(eventsBefore);
    });

    it("kick：非管理员 403；成员在 200 返回前已移除、member_left 在响应之后推；被 promote 的成员也能 kick", async () => {
      const { groupId, memberPu } = await setupGroup(app);
      await call(app, "POST", "/accounts/a3/connect");
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      const a3 = await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a3",
        inviteLink: inv.body.inviteLink,
      });
      expect(a3.status).toBe(202);
      await vi.advanceTimersByTimeAsync(1);

      const denied = await call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a2",
        targetPlatformUserId: memberPu,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("NO_PERMISSION");

      await scenario(app, { kick: { responseDelayMs: 2000 } });
      const eventsBefore = (await state(app)).events.count;
      const pending = call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a1",
        targetPlatformUserId: memberPu,
      });
      await settle();
      // 响应还没回：成员列表已经没有他，事件还没推
      const during = await call(app, "GET", `/groups/${groupId}/members`);
      expect(during.body).not.toContainEqual({ platformUserId: memberPu });
      expect((await state(app)).events.count).toBe(eventsBefore);

      await vi.advanceTimersByTimeAsync(2000);
      const kicked = await pending;
      expect(kicked.status).toBe(200);
      expect(kicked.body).toEqual({ kicked: true });
      await vi.advanceTimersByTimeAsync(1);
      const left = eventsOf(await state(app), "member_left");
      expect(left).toHaveLength(1);
      expect(left[0]?.data).toMatchObject({
        groupId,
        platformUserId: memberPu,
      });

      // 被 promote 的 a3 可以 kick（这里 kick 群主之外的人不存在了，直接验证权限判定：目标不在群 → 409 NOT_IN_GROUP 而非 403）
      await call(app, "POST", `/groups/${groupId}/promote`, {
        byAccountId: "a1",
        accountId: "a3",
      });
      await scenario(app, { kick: { responseDelayMs: 0 } });
      const byAdmin = await call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a3",
        targetPlatformUserId: memberPu,
      });
      expect(byAdmin.status).toBe(409);
      expect(byAdmin.body.code).toBe("NOT_IN_GROUP");
    });

    it("kick 超时 504 NETWORK_TIMEOUT：结果未知，2 秒内收敛（removed=true 时成员列表变化 + member_left）", async () => {
      const { groupId, memberPu } = await setupGroup(app);
      await scenario(app, {
        kick: {
          responseDelayMs: 0,
          timeout: { removed: true, convergeAfterMs: 1500 },
        },
      });
      const res = await call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a1",
        targetPlatformUserId: memberPu,
      });
      expect(res.status).toBe(504);
      expect(res.body.code).toBe("NETWORK_TIMEOUT");
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toContainEqual({ platformUserId: memberPu });

      await vi.advanceTimersByTimeAsync(1500);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).not.toContainEqual({ platformUserId: memberPu });
      expect(eventsOf(await state(app), "member_left")).toHaveLength(1);

      // removed=false：504 之后什么都不发生
      await scenario(app, {
        kick: { timeout: { removed: false, convergeAfterMs: 0 } },
      });
      await call(app, "POST", "/accounts/a3/connect");
      const inv = await call(app, "POST", `/groups/${groupId}/invite`);
      await call(app, "POST", `/groups/${groupId}/join`, {
        accountId: "a3",
        inviteLink: inv.body.inviteLink,
      });
      await vi.advanceTimersByTimeAsync(1);
      const a3Pu = (await call(app, "POST", "/accounts/a3/connect")).body
        .platformUserId as string;
      const again = await call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a1",
        targetPlatformUserId: a3Pu,
      });
      expect(again.status).toBe(504);
      await vi.advanceTimersByTimeAsync(3000);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toContainEqual({ platformUserId: a3Pu });
      expect(eventsOf(await state(app), "member_left")).toHaveLength(1);
    });

    it("leave：200 后推 member_left；场景 fail → 500 没退成；群主退群后 kick → 409 OWNER_LEFT", async () => {
      const { groupId, ownerPu, memberPu } = await setupGroup(app);

      await scenario(app, { leave: { fail: true } });
      const failed = await call(app, "POST", `/groups/${groupId}/leave`, {
        accountId: "a2",
      });
      expect(failed.status).toBe(500);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toContainEqual({ platformUserId: memberPu });

      await scenario(app, { leave: { fail: false } });
      const ok = await call(app, "POST", `/groups/${groupId}/leave`, {
        accountId: "a1",
      });
      expect(ok.status).toBe(200);
      await vi.advanceTimersByTimeAsync(1);
      const s = await state(app);
      expect(eventsOf(s, "member_left")[0]?.data).toMatchObject({
        groupId,
        platformUserId: ownerPu,
      });
      expect(s.groups[0]?.ownerLeft).toBe(true);

      // 群主已退群：任何 kick 都是 OWNER_LEFT（哪怕是被 promote 过的）
      await call(app, "POST", "/accounts/a1/connect");
      const kick = await call(app, "POST", `/groups/${groupId}/kick`, {
        byAccountId: "a2",
        targetPlatformUserId: ownerPu,
      });
      expect(kick.status).toBe(409);
      expect(kick.body.code).toBe("OWNER_LEFT");
    });
  });

  describe("send", () => {
    it("S1：202 { accepted: true } 后延迟推 message_sent；S3：自己的消息作为 message 事件回流（同一 msgId）", async () => {
      const { groupId, memberPu } = await setupGroup(app);
      await scenario(app, { send: { eventDelayMs: 800, acceptDelayMs: 1000 } });

      const pending = sendMsg(app, groupId, "a2", "c1");
      await settle();
      await vi.advanceTimersByTimeAsync(1000);
      const res = await pending;
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
      expect(eventsOf(await state(app), "message_sent")).toHaveLength(0);
      expect(
        (await call(app, "GET", `/groups/${groupId}/messages/by-client-id/c1`))
          .status,
      ).toBe(404);

      await vi.advanceTimersByTimeAsync(800);
      const s = await state(app);
      const sent = eventsOf(s, "message_sent");
      const echoed = eventsOf(s, "message");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.data).toMatchObject({
        clientMsgId: "c1",
        msgId: anyString,
        sentAt: anyString,
      });
      expect(echoed[0]?.data).toMatchObject({
        groupId,
        msgId: sent[0]?.data.msgId,
        senderPlatformUserId: memberPu,
        text: "text-c1",
        sentAt: sent[0]?.data.sentAt,
      });
      const found = await call(
        app,
        "GET",
        `/groups/${groupId}/messages/by-client-id/c1`,
      );
      expect(found.status).toBe(200);
      expect(found.body).toEqual({
        msgId: sent[0]?.data.msgId,
        sentAt: sent[0]?.data.sentAt,
      });
    });

    it("message_failed { clientMsgId, code }：含义与同步错误相同，之后该群不可写", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, {
        send: { outcome: "failed:GROUP_WRITE_FORBIDDEN" },
      });
      expect((await sendMsg(app, groupId, "a2", "c-f")).status).toBe(202);
      await vi.advanceTimersByTimeAsync(1);
      const s = await state(app);
      expect(eventsOf(s, "message_failed")[0]?.data).toMatchObject({
        clientMsgId: "c-f",
        code: "GROUP_WRITE_FORBIDDEN",
      });
      expect(s.messages).toHaveLength(0);
      await scenario(app, { send: { outcome: "sent" } });
      const next = await sendMsg(app, groupId, "a2", "c-g");
      expect(next.status).toBe(403);
      expect(next.body.code).toBe("GROUP_WRITE_FORBIDDEN");
    });

    it("S4：429 RATE_LIMITED { retryAfterSeconds }，等待期内再次 429 且计时重置，到期恢复", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, {
        send: { responses: [{ status: 429, retryAfterSeconds: 3 }] },
      });

      const first = await sendMsg(app, groupId, "a2", "r1");
      expect(first.status).toBe(429);
      expect(first.body).toMatchObject({
        code: "RATE_LIMITED",
        retryAfterSeconds: 3,
      });

      await vi.advanceTimersByTimeAsync(2000);
      const second = await sendMsg(app, groupId, "a2", "r2");
      expect(second.status).toBe(429);
      expect(second.body.retryAfterSeconds).toBe(3);

      // 从第二次算起 2s：距首次 4s 已超过 3s，但计时已重置，仍在限流
      await vi.advanceTimersByTimeAsync(2000);
      expect((await sendMsg(app, groupId, "a2", "r3")).status).toBe(429);

      await vi.advanceTimersByTimeAsync(3000);
      expect((await sendMsg(app, groupId, "a2", "r4")).status).toBe(202);
      // 别的账号不受影响
      expect((await sendMsg(app, groupId, "a1", "o1")).status).toBe(202);
      const s = await state(app);
      expect(s.sendCalls.map((c) => c.status)).toEqual([
        429, 429, 429, 202, 202,
      ]);
    });

    it("403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED 是终态：之后所有请求（含 connect）同样的错误，并被移出群", async () => {
      const { groupId, memberPu, ownerPu } = await setupGroup(app);
      await scenario(app, {
        send: {
          responses: [
            {
              status: 403,
              code: "ACCOUNT_SUSPENDED",
              match: { accountId: "a2" },
            },
            { status: 401, match: { accountId: "a1" }, pushStatusEvent: false },
          ],
        },
      });

      const suspended = await sendMsg(app, groupId, "a2", "s1");
      expect(suspended.status).toBe(403);
      expect(suspended.body.code).toBe("ACCOUNT_SUSPENDED");
      expect((await sendMsg(app, groupId, "a2", "s2")).body.code).toBe(
        "ACCOUNT_SUSPENDED",
      );
      expect((await call(app, "POST", "/accounts/a2/connect")).status).toBe(
        403,
      );
      expect(
        (
          await call(app, "POST", `/groups/${groupId}/leave`, {
            accountId: "a2",
          })
        ).status,
      ).toBe(403);

      const expired = await sendMsg(app, groupId, "a1", "e1");
      expect(expired.status).toBe(401);
      expect(expired.body.code).toBe("SESSION_EXPIRED");
      expect((await call(app, "POST", "/accounts/a1/connect")).status).toBe(
        401,
      );

      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toEqual([]);
      const s = await state(app);
      expect(
        eventsOf(s, "account_status").map((e) => e.data.accountId),
      ).toEqual(["a2"]);
      expect(
        eventsOf(s, "member_left").map((e) => e.data.platformUserId),
      ).toEqual([memberPu, ownerPu]);
    });

    it("403 GROUP_WRITE_FORBIDDEN（场景名单）/ 403 SENDER_NOT_IN_GROUP / 404 GROUP_NOT_FOUND", async () => {
      const { groupId } = await setupGroup(app);
      await call(app, "POST", "/accounts/a3/connect");
      const outsider = await sendMsg(app, groupId, "a3", "x1");
      expect(outsider.status).toBe(403);
      expect(outsider.body.code).toBe("SENDER_NOT_IN_GROUP");

      const missing = await sendMsg(app, "g_nope", "a2", "x2");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("GROUP_NOT_FOUND");

      await scenario(app, { groups: { writeForbidden: [groupId] } });
      const forbidden = await sendMsg(app, groupId, "a2", "x3");
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe("GROUP_WRITE_FORBIDDEN");
    });

    it("S5：504 NETWORK_TIMEOUT 后 1.5s 落地：by-client-id 先 404 后 200，推 message_sent，网关里恰好一条", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, {
        send: { responses: [{ status: 504, landAfterMs: 1500 }] },
      });
      const res = await sendMsg(app, groupId, "a2", "k1");
      expect(res.status).toBe(504);
      expect(res.body.code).toBe("NETWORK_TIMEOUT");
      const query = `/groups/${groupId}/messages/by-client-id/k1`;
      expect((await call(app, "GET", query)).status).toBe(404);

      await vi.advanceTimersByTimeAsync(1499);
      expect((await call(app, "GET", query)).status).toBe(404);
      await vi.advanceTimersByTimeAsync(1);
      const found = await call(app, "GET", query);
      expect(found.status).toBe(200);
      const s = await state(app);
      expect(s.messages).toHaveLength(1);
      expect(eventsOf(s, "message_sent")[0]?.data).toMatchObject({
        clientMsgId: "k1",
        msgId: found.body.msgId,
      });
      expect(s.sendCalls).toEqual([
        {
          accountId: "a2",
          groupId,
          clientMsgId: "k1",
          status: 504,
          code: "NETWORK_TIMEOUT",
        },
      ]);
    });

    it("504 且没发出：2 秒后仍 404，即可确定没有发出", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, { send: { responses: [{ status: 504 }] } });
      expect((await sendMsg(app, groupId, "a2", "k2")).status).toBe(504);
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        (await call(app, "GET", `/groups/${groupId}/messages/by-client-id/k2`))
          .status,
      ).toBe(404);
      expect((await state(app)).messages).toHaveLength(0);
    });

    it("不按 clientMsgId 去重：同一个 clientMsgId 发两次就是两条；by-client-id 返回最早的一条", async () => {
      const { groupId } = await setupGroup(app);
      expect((await sendMsg(app, groupId, "a2", "dup")).status).toBe(202);
      await vi.advanceTimersByTimeAsync(10);
      expect((await sendMsg(app, groupId, "a2", "dup")).status).toBe(202);
      await vi.advanceTimersByTimeAsync(10);

      const s = await state(app);
      const both = s.messages.filter((m) => m.clientMsgId === "dup");
      expect(both).toHaveLength(2);
      expect(both[0]?.msgId).not.toBe(both[1]?.msgId);
      expect(eventsOf(s, "message_sent")).toHaveLength(2);
      const earliest = await call(
        app,
        "GET",
        `/groups/${groupId}/messages/by-client-id/dup`,
      );
      expect(earliest.body).toEqual({
        msgId: both[0]?.msgId,
        sentAt: both[0]?.sentAt,
      });
      expect((both[0]?.sentAt ?? "") < (both[1]?.sentAt ?? "")).toBe(true);
    });

    it("脚本响应 503 / 409 / SENDER_NOT_IN_GROUP 只影响这一次，队列空了走默认 202", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, {
        send: {
          responses: [
            { status: 503 },
            { status: 409 },
            { status: 403, code: "SENDER_NOT_IN_GROUP" },
          ],
        },
      });
      const codes: string[] = [];
      for (const id of ["q1", "q2", "q3", "q4"]) {
        const res = await sendMsg(app, groupId, "a2", id);
        const code = typeof res.body.code === "string" ? res.body.code : "";
        codes.push(`${res.status} ${code}`.trim());
      }
      expect(codes).toEqual([
        "503 SERVICE_UNAVAILABLE",
        "409 ACCOUNT_OFFLINE",
        "403 SENDER_NOT_IN_GROUP",
        "202",
      ]);
    });
  });

  describe("整体 503 开关与管理端点", () => {
    it("outage.all：任意端点（含 by-client-id）503 SERVICE_UNAVAILABLE，/_sim 不受影响；reset 后恢复", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, { outage: { all: true } });
      for (const [method, url] of [
        ["POST", "/accounts/a1/connect"],
        ["POST", `/groups/${groupId}/send`],
        ["GET", `/groups/${groupId}/messages/by-client-id/x`],
        ["GET", `/groups/${groupId}/members`],
        ["GET", "/events?since=0"],
      ] as const) {
        const res = await call(
          app,
          method,
          url,
          method === "POST" ? {} : undefined,
        );
        expect(res.status).toBe(503);
        expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
      }
      expect((await call(app, "GET", "/_sim/state")).status).toBe(200);

      await call(app, "POST", "/_sim/reset");
      expect((await call(app, "POST", "/accounts/a1/connect")).status).toBe(
        200,
      );
    });

    it("outage.routes：只让 by-client-id 不可用，其他端点照常", async () => {
      const { groupId } = await setupGroup(app);
      await scenario(app, { outage: { routes: ["by-client-id"] } });
      expect(
        (await call(app, "GET", `/groups/${groupId}/messages/by-client-id/x`))
          .status,
      ).toBe(503);
      expect((await sendMsg(app, groupId, "a2", "ok")).status).toBe(202);
    });

    it("场景补丁校验：非法字段 400；GET /_sim/scenario 回显合并结果；reset 清空状态与场景", async () => {
      const bad = await scenario(app, { events: { duplicates: 0 } });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("BAD_REQUEST");

      await scenario(app, {
        events: { duplicates: 2 },
        join: { delayMs: { min: 5, max: 9 } },
      });
      const current = await call(app, "GET", "/_sim/scenario");
      expect(current.body.events).toMatchObject({
        duplicates: 2,
        reorderWindowMs: 0,
      });
      expect(current.body.join).toMatchObject({ delayMs: { min: 5, max: 9 } });

      await setupGroup(app);
      await call(app, "POST", "/_sim/reset");
      const s = await state(app);
      expect(s.groups).toHaveLength(0);
      expect(s.events).toMatchObject({ count: 0, lastEventId: 0 });
      expect(
        (await call(app, "GET", "/_sim/scenario")).body.events,
      ).toMatchObject({ duplicates: 1 });
    });

    it("/_sim/push：外部用户消息 / 进出群；media 过期 404；redeliver 带新 eventId、原 msgId 与 sentAt", async () => {
      const { groupId } = await setupGroup(app);
      const joined = await call(app, "POST", "/_sim/push", {
        kind: "member_joined",
        groupId,
        platformUserId: "ext-1",
      });
      expect(joined.status).toBe(200);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).toContainEqual({
        platformUserId: "ext-1",
      });

      const msg = await call(app, "POST", "/_sim/push", {
        kind: "message",
        groupId,
        senderPlatformUserId: "ext-1",
        text: "hello",
        media: {
          contentType: "text/plain",
          base64: Buffer.from("bytes").toString("base64"),
        },
      });
      expect(msg.status).toBe(200);
      const s1 = await state(app);
      const original = eventsOf(s1, "message").at(-1);
      expect(original?.data).toMatchObject({
        groupId,
        senderPlatformUserId: "ext-1",
        text: "hello",
        mediaUrl: mediaPath,
      });
      const media = await app.inject({
        method: "GET",
        url: original?.data.mediaUrl as string,
      });
      expect(media.statusCode).toBe(200);
      expect(media.body).toBe("bytes");

      const expiring = await call(app, "POST", "/_sim/push", {
        kind: "message",
        groupId,
        text: "gone",
        media: { contentType: "image/png", base64: "", expiresAfterMs: 100 },
      });
      const gone = eventsOf(await state(app), "message").at(-1);
      expect(expiring.status).toBe(200);
      await vi.advanceTimersByTimeAsync(100);
      expect(
        (
          await app.inject({
            method: "GET",
            url: gone?.data.mediaUrl as string,
          })
        ).statusCode,
      ).toBe(404);

      const re = await call(app, "POST", "/_sim/push", {
        kind: "redeliver",
        msgId: original?.data.msgId,
      });
      const redelivered = eventsOf(await state(app), "message").at(-1);
      expect(re.body.eventIds).toEqual([redelivered?.eventId]);
      expect(redelivered?.eventId).toBeGreaterThan(original?.eventId ?? 0);
      expect(redelivered?.data).toMatchObject({
        msgId: original?.data.msgId,
        sentAt: original?.data.sentAt,
      });

      const left = await call(app, "POST", "/_sim/push", {
        kind: "member_left",
        groupId,
        platformUserId: "ext-1",
      });
      expect(left.status).toBe(200);
      expect(
        (await call(app, "GET", `/groups/${groupId}/members`)).body,
      ).not.toContainEqual({
        platformUserId: "ext-1",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// SSE：真 socket、真定时器
// ---------------------------------------------------------------------------

interface Frame {
  id: number;
  event: string;
  data: Json;
}

function parseFrame(raw: string): Frame {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx), line.slice(idx + 1).trimStart());
  }
  return {
    id: Number(fields.get("id")),
    event: fields.get("event") ?? "",
    data: JSON.parse(fields.get("data") ?? "{}") as Json,
  };
}

interface Stream {
  next(): Promise<Frame | null>;
  close(): void;
}

/** 打开 SSE 连接（headers 到达后返回，此时服务端已登记订阅），逐帧读取；连接结束后 next() 返回 null。 */
async function openStream(url: string): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const queue: Frame[] = [];
  let ended = false;
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  void (async () => {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          queue.push(parseFrame(buf.slice(0, idx)));
          buf = buf.slice(idx + 2);
          idx = buf.indexOf("\n\n");
        }
        wake();
      }
    } catch {
      // 服务端掐断 / 本地 abort：都算结束
    }
    ended = true;
    wake();
  })();
  return {
    async next() {
      while (queue.length === 0 && !ended) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return queue.shift() ?? null;
    },
    close: () => ac.abort(),
  };
}

describe("网关模拟器：SSE 事件流（真 socket）", () => {
  let app: FastifyInstance;
  let base: string;
  /** 注入的随机源：队列里有值就用，否则 0（= 每个范围取 min） */
  const randomQueue: number[] = [];

  beforeAll(async () => {
    app = await buildGatewayApp({
      logger: false,
      random: () => randomQueue.shift() ?? 0,
    });
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    randomQueue.length = 0;
    await call(app, "POST", "/_sim/reset");
    await scenario(app, { join: { delayMs: 0 }, send: { eventDelayMs: 0 } });
  });

  const push = (kind: string, extra: Json) =>
    call(app, "POST", "/_sim/push", { kind, ...extra });

  async function seedGroup(): Promise<string> {
    await call(app, "POST", "/accounts/a1/connect");
    const g = await call(app, "POST", "/groups", { creatorAccountId: "a1" });
    return g.body.groupId as string;
  }

  it("帧格式 id / event / data（data 带 eventId 与 type）；eventId 全局递增；since 独占回放全部历史", async () => {
    const groupId = await seedGroup();
    await push("member_joined", { groupId, platformUserId: "u1" });
    await push("message", { groupId, senderPlatformUserId: "u1", text: "hi" });
    await push("member_left", { groupId, platformUserId: "u1" });

    const all = await openStream(`${base}/events?since=0`);
    const frames = [await all.next(), await all.next(), await all.next()];
    all.close();
    expect(frames.map((f) => f?.id)).toEqual([1, 2, 3]);
    expect(frames.map((f) => f?.event)).toEqual([
      "member_joined",
      "message",
      "member_left",
    ]);
    expect(frames[1]?.data).toMatchObject({
      eventId: 2,
      type: "message",
      groupId,
      senderPlatformUserId: "u1",
      text: "hi",
      msgId: anyString,
      sentAt: anyString,
    });

    const tail = await openStream(`${base}/events?since=2`);
    expect((await tail.next())?.id).toBe(3);
    // 回放之后接实时
    await push("member_joined", { groupId, platformUserId: "u2" });
    expect((await tail.next())?.id).toBe(4);
    tail.close();
  });

  it("不带 since：只收连接之后的事件；事件流不依赖任何账号 connect", async () => {
    const groupId = await seedGroup();
    await push("member_joined", { groupId, platformUserId: "before" });
    const live = await openStream(`${base}/events`);
    await push("member_joined", { groupId, platformUserId: "after" });
    const frame = await live.next();
    live.close();
    expect(frame?.data).toMatchObject({ platformUserId: "after", eventId: 2 });
  });

  it("S2：场景 duplicates=2 → 每个事件推两次（同一 eventId），历史里仍只记一条", async () => {
    const groupId = await seedGroup();
    await scenario(app, { events: { duplicates: 2 } });
    const live = await openStream(`${base}/events`);
    await push("member_joined", { groupId, platformUserId: "dup" });
    const [a, b] = [await live.next(), await live.next()];
    live.close();
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(1);
    expect(b).toEqual(a);
    expect((await state(app)).events.count).toBe(1);
  });

  it("乱序窗口 ≤ 1s：注入随机源让先发的事件晚到，客户端先收到 eventId 更大的", async () => {
    const groupId = await seedGroup();
    await scenario(app, { events: { reorderWindowMs: 200 } });
    const live = await openStream(`${base}/events`);
    randomQueue.push(0.99, 0); // 第一条延迟 ~200ms，第二条立即
    await push("member_joined", { groupId, platformUserId: "slow" });
    await push("member_joined", { groupId, platformUserId: "fast" });
    const [first, second] = [await live.next(), await live.next()];
    live.close();
    expect(first?.data.platformUserId).toBe("fast");
    expect(second?.data.platformUserId).toBe("slow");
    expect((first?.id ?? 0) > (second?.id ?? 0)).toBe(true);
  });

  it("连接可被场景掐断（disconnectAfterFrames）或手动掐断（/_sim/streams/disconnect）；带 since 重连补拉", async () => {
    const groupId = await seedGroup();
    await scenario(app, { events: { disconnectAfterFrames: 1 } });
    const dropped = await openStream(`${base}/events`);
    await push("member_joined", { groupId, platformUserId: "x1" });
    await push("member_joined", { groupId, platformUserId: "x2" });
    expect((await dropped.next())?.id).toBe(1);
    expect(await dropped.next()).toBeNull();

    await scenario(app, { events: { disconnectAfterFrames: null } });
    const resumed = await openStream(`${base}/events?since=1`);
    expect((await resumed.next())?.id).toBe(2);
    expect((await state(app)).streams.open).toBe(1);
    const cut = await call(app, "POST", "/_sim/streams/disconnect");
    expect(cut.body).toEqual({ disconnected: 1 });
    expect(await resumed.next()).toBeNull();
    expect((await state(app)).streams.open).toBe(0);
  });

  it("离线补投：redeliver 的 message 事件 eventId 更大、msgId / sentAt 为原值", async () => {
    const groupId = await seedGroup();
    const live = await openStream(`${base}/events`);
    await push("message", { groupId, text: "old" });
    const original = await live.next();
    await push("redeliver", { msgId: original?.data.msgId });
    const again = await live.next();
    live.close();
    expect(again?.id).toBeGreaterThan(original?.id ?? 0);
    expect(again?.data).toMatchObject({
      msgId: original?.data.msgId,
      sentAt: original?.data.sentAt,
      text: "old",
    });
  });
});
