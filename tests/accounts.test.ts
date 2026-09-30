// issue #6：账号状态机（题目 A1 + 2.3 的 accounts 三个端点）。
// 真库（tests/setup.ts 的临时 schema）；网关用 src/sim/gateway 的 buildGatewayApp 起在 listen(0) 上，
// 地址经 buildApp({ gateway: createGatewayClient({ baseUrl }) }) 注入路由 —— 走的是真 HTTP + 全局 fetch，
// setup.ts 的 MockAgent 放行 localhost。
// 时间：业务时间全部走可注入 Clock，不写死年月、不真 sleep；worker 的 tick 用假定时器推。
// 并发 CAS（多连接真并行）在 tests/accounts-concurrency.test.ts。
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

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { AccountStatus } from "../src/db/generated/client.js";
import {
  enterRateLimited,
  enterTerminal,
  recoverRateLimited,
  transition,
  type TransitionSource,
} from "../src/services/account-service.js";
import { createGatewayClient } from "../src/services/gateway-client.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { startRateLimitWorker } from "../src/workers/rate-limit-worker.js";
import { loginAs, makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const ALL_STATUSES: readonly AccountStatus[] = [
  "idle",
  "online",
  "rate_limited",
  "disconnected",
  "suspended",
  "session_expired",
];

/** 题目 A1 的转移表（行 = 当前状态，列 = 目标状态）—— 独立于 service 里的定义抄自题目，作为测试的预言机。 */
const LEGAL: Readonly<Record<AccountStatus, readonly AccountStatus[]>> = {
  idle: ["online", "suspended", "session_expired"],
  online: [
    "idle",
    "rate_limited",
    "disconnected",
    "suspended",
    "session_expired",
  ],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
};
const TERMINAL: readonly AccountStatus[] = ["suspended", "session_expired"];

/** 可拨动的假时钟：业务「过了多久」用它，不用 setTimeout。 */
function fakeClock(start = new Date()): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
  };
}

/** 造一个处于指定状态的账号（rate_limited 要带截止时刻，库里有 CHECK）。 */
async function accountIn(status: AccountStatus, clock: Clock = fakeClock()) {
  return makeAccount({
    status,
    ...(status === "rate_limited"
      ? { rateLimitedUntil: new Date(clock.now().getTime() + 30_000) }
      : {}),
    ...(status === "idle" ? { platformUserId: null } : {}),
  });
}

async function wsEvents(type?: string) {
  return getDb().wsEvent.findMany({
    where: type ? { type } : {},
    orderBy: { id: "asc" },
  });
}

describe("accounts", () => {
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayUrl: string;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    gateway = await buildGatewayApp({ logger: false });
    gatewayUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
    app = await buildApp({
      logger: false,
      gateway: createGatewayClient({ baseUrl: gatewayUrl }),
    });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
    await closeDb();
  });

  const post = (url: string, headers: Record<string, string>, payload?: Json) =>
    app.inject({ method: "POST", url, headers, payload });

  // ---- GET /api/accounts ------------------------------------------------------------

  describe("GET /api/accounts", () => {
    it("主流程：viewer 能看，字段按题目 2.3，时间为 ISO / null", async () => {
      const clock = fakeClock();
      const a = await accountIn("idle");
      const b = await accountIn("rate_limited", clock);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts",
        headers: viewer,
      });
      expect(res.statusCode).toBe(200);
      const items = res.json<Json[]>();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
      const idle = items.find((i) => i.id === a.id);
      expect(idle).toEqual({
        id: a.id,
        status: "idle",
        platformUserId: null,
        rateLimitedUntil: null,
      });
      const limited = items.find((i) => i.id === b.id);
      expect(limited).toMatchObject({
        status: "rate_limited",
        platformUserId: `pu-${b.id}`,
        rateLimitedUntil: b.rateLimitedUntil?.toISOString(),
      });
    });

    it("边界：未登录 401 UNAUTHORIZED", async () => {
      const res = await app.inject({ method: "GET", url: "/api/accounts" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });
  });

  // ---- POST /api/accounts/:id/transition ---------------------------------------------

  describe("POST /api/accounts/:id/transition：转移表全矩阵", () => {
    const cases = ALL_STATUSES.flatMap((from) =>
      ALL_STATUSES.map((to) => ({ from, to })),
    );

    it.each(cases)("$from → $to", async ({ from, to }) => {
      const account = await accountIn(from);
      const res = await post(`/api/accounts/${account.id}/transition`, admin, {
        to,
        expectedFrom: from,
      });
      const row = await getDb().account.findUniqueOrThrow({
        where: { id: account.id },
      });
      const changedEvents = await wsEvents("account_status_changed");

      if (LEGAL[from].includes(to)) {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          id: account.id,
          status: to,
          from,
          changed: true,
        });
        expect(row.status).toBe(to);
        expect(row.version).toBe(account.version + 1);
        expect(row.rateLimitedUntil === null).toBe(to !== "rate_limited");
        // 状态事件与状态同一事务落库：payload 就是这次转移
        expect(changedEvents.map((e) => e.payload)).toEqual([
          { accountId: account.id, from, to },
        ]);
        expect((await wsEvents("account_terminal")).length).toBe(
          TERMINAL.includes(to) ? 1 : 0,
        );
        return;
      }

      if (from === to && TERMINAL.includes(to)) {
        // 重复进入同一终态：静默忽略 —— 不报错、状态 / version 不动、不发事件
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: to, changed: false });
        expect(row.version).toBe(account.version);
        expect(changedEvents).toHaveLength(0);
        return;
      }

      // 表外（含同状态到同状态、终态出边）：409 ILLEGAL_TRANSITION，什么都没写
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "ILLEGAL_TRANSITION", from, to },
      });
      expect(row.status).toBe(from);
      expect(row.version).toBe(account.version);
      expect(changedEvents).toHaveLength(0);
    });
  });

  describe("POST /api/accounts/:id/transition：边界", () => {
    it("expectedFrom 与当前状态不符 → 409 CAS_CONFLICT，不写", async () => {
      const account = await accountIn("online");
      // idle → online 在表上，但账号当前是 online：转移表检查过了、CAS 拦住
      const res = await post(`/api/accounts/${account.id}/transition`, admin, {
        to: "online",
        expectedFrom: "idle",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: {
          code: "CAS_CONFLICT",
          expectedFrom: "idle",
          current: "online",
        },
      });
      const row = await getDb().account.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(row.version).toBe(account.version);
      expect(await wsEvents()).toHaveLength(0);
    });

    it("账号不存在 → 404 ACCOUNT_NOT_FOUND", async () => {
      const res = await post("/api/accounts/nope/transition", admin, {
        to: "online",
        expectedFrom: "idle",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: { code: "ACCOUNT_NOT_FOUND" },
      });
    });

    it("expectedFrom 缺失 / to 不是合法状态 → 400 VALIDATION_ERROR", async () => {
      const account = await accountIn("idle");
      const missing = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        { to: "online" },
      );
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });

      const bogus = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        {
          to: "banned",
          expectedFrom: "idle",
        },
      );
      expect(bogus.statusCode).toBe(400);
      expect(bogus.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("idle");
    });

    it("viewer 对写操作 403 FORBIDDEN（transition 与 connect）", async () => {
      const account = await accountIn("online");
      const t = await post(`/api/accounts/${account.id}/transition`, viewer, {
        to: "idle",
        expectedFrom: "online",
      });
      expect(t.statusCode).toBe(403);
      expect(t.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      const c = await post(`/api/accounts/${account.id}/connect`, viewer);
      expect(c.statusCode).toBe(403);
      expect(c.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("online");
    });

    it("标 disconnected / idle 时调网关 disconnect；网关断不开不影响本地状态", async () => {
      const account = await accountIn("idle");
      // 先经网关 connect，网关侧 online = true
      const connected = await post(
        `/api/accounts/${account.id}/connect`,
        admin,
      );
      expect(connected.statusCode).toBe(200);

      const res = await post(`/api/accounts/${account.id}/transition`, admin, {
        to: "disconnected",
        expectedFrom: "online",
      });
      expect(res.statusCode).toBe(200);
      const state = (
        await gateway.inject({ method: "GET", url: "/_sim/state" })
      ).json<{ accounts: { accountId: string; online: boolean }[] }>();
      expect(
        state.accounts.find((a) => a.accountId === account.id)?.online,
      ).toBe(false);

      // 网关整体 503：本地照样 disconnected → idle，只是网关没收到
      await gateway.inject({
        method: "POST",
        url: "/_sim/scenario",
        payload: { outage: { all: true } },
      });
      const again = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        {
          to: "idle",
          expectedFrom: "disconnected",
        },
      );
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: "idle", changed: true });
    });
  });

  // ---- 终态级联 ----------------------------------------------------------------------

  describe("终态级联（一个事务；三种来源结果一致）", () => {
    /**
     * 布景：账号在两个群里；出站消息 queued / accepted / unknown / sent 各一条；
     * 序列步骤两条：一条指向 queued 消息（pending），一条指向 sent 消息（sent）。
     */
    async function stage() {
      const account = await accountIn("online");
      const other = await accountIn("online");
      const g1 = await makeGroup({ creatorAccountId: account.id });
      const g2 = await makeGroup({ creatorAccountId: other.id });
      const db = getDb();
      await db.groupMember.createMany({
        data: [
          {
            groupId: g1.id,
            platformUserId: account.platformUserId!,
            accountId: account.id,
            role: "creator",
          },
          {
            groupId: g2.id,
            platformUserId: account.platformUserId!,
            accountId: account.id,
            role: "member",
          },
          // 别人的成员行不受影响
          {
            groupId: g2.id,
            platformUserId: other.platformUserId!,
            accountId: other.id,
            role: "creator",
          },
          // 外部用户（无 accountId）不受影响
          { groupId: g1.id, platformUserId: "pu-external" },
        ],
      });
      const sentAt = new Date();
      const mk = (
        clientMsgId: string,
        deliveryStatus: "queued" | "accepted" | "unknown" | "sent",
        accountId = account.id,
      ) =>
        db.message.create({
          data: {
            groupId: g1.id,
            clientMsgId,
            accountId,
            senderPlatformUserId: account.platformUserId!,
            isOwn: true,
            text: clientMsgId,
            sentAt,
            deliveryStatus,
            ...(deliveryStatus === "sent" ? { msgId: `m-${clientMsgId}` } : {}),
          },
        });
      await mk("c-queued", "queued");
      await mk("c-accepted", "accepted");
      await mk("c-unknown", "unknown");
      await mk("c-sent", "sent");
      // 别人的排队消息不受影响
      await mk("c-other-queued", "queued", other.id);

      const sequence = await db.sequence.create({
        data: { name: "s", steps: [] },
      });
      const run = await db.sequenceRun.create({
        data: {
          sequenceId: sequence.id,
          groupId: g1.id,
          vars: {},
          stepVars: {},
        },
      });
      const step = (
        index: number,
        clientMsgId: string,
        status: "pending" | "sent",
      ) =>
        db.sequenceRunStep.create({
          data: {
            runId: run.id,
            index,
            accountRole: "admin",
            template: "t",
            delaySeconds: 0,
            status,
            resolvedVars: {},
            varSources: {},
            accountId: account.id,
            clientMsgId,
          },
        });
      await step(1, "c-sent", "sent");
      await step(2, "c-queued", "pending");
      return { account, other, g1, g2 };
    }

    async function assertCascaded(accountId: string, status: AccountStatus) {
      const db = getDb();
      const row = await db.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(row.status).toBe(status);
      // 成员行：该账号的全没了，别人与外部用户还在
      const members = await db.groupMember.findMany();
      expect(members.filter((m) => m.accountId === accountId)).toHaveLength(0);
      expect(members).toHaveLength(2);
      // 消息：只有 queued 变 cancelled + ACCOUNT_TERMINAL；accepted / unknown / sent 原样；别人的 queued 原样
      const messages = await db.message.findMany({
        orderBy: { clientMsgId: "asc" },
      });
      const byId: Record<string, [string | null, string | null]> =
        Object.fromEntries(
          messages.map((m) => [
            m.clientMsgId ?? "",
            [m.deliveryStatus, m.failCode],
          ]),
        );
      expect(byId).toEqual({
        "c-accepted": ["accepted", null],
        "c-other-queued": ["queued", null],
        "c-queued": ["cancelled", "ACCOUNT_TERMINAL"],
        "c-sent": ["sent", null],
        "c-unknown": ["unknown", null],
      });
      // 序列步骤：指向被取消消息的那步 skipped，已 sent 的不动
      const steps = await db.sequenceRunStep.findMany({
        orderBy: { index: "asc" },
      });
      expect(steps.map((s) => [s.index, s.status, s.failCode])).toEqual([
        [1, "sent", null],
        [2, "skipped", "ACCOUNT_TERMINAL"],
      ]);
      expect(steps[1]?.skippedAt).not.toBeNull();
      // 事件：被取消那条的 message（时间线跟着变）+ 状态事件 + account_terminal，都对应已保存的状态
      const cancelled = messages.find((m) => m.clientMsgId === "c-queued");
      expect((await wsEvents()).map((e) => [e.type, e.payload])).toEqual([
        [
          "message",
          {
            groupId: cancelled?.groupId,
            msgId: null,
            clientMsgId: "c-queued",
            isOwn: true,
            deliveryStatus: "cancelled",
            failCode: "ACCOUNT_TERMINAL",
          },
        ],
        ["account_status_changed", { accountId, from: "online", to: status }],
        ["account_terminal", { accountId, status }],
      ]);
    }

    it("操作员标 suspended：成员移出、queued → cancelled、步骤 skipped、推 account_terminal，响应带计数", async () => {
      const { account } = await stage();
      const res = await post(`/api/accounts/${account.id}/transition`, admin, {
        to: "suspended",
        expectedFrom: "online",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "suspended",
        from: "online",
        changed: true,
        membersRemovedCount: 2,
        messagesCancelledCount: 1,
        stepsSkippedCount: 1,
      });
      await assertCascaded(account.id, "suspended");
    });

    it.each<Exclude<TransitionSource, "rate_limit_worker">>([
      "gateway_event",
      "send_error",
    ])(
      "来源 %s（enterTerminal）进 session_expired：与操作员标记结果一致",
      async (source) => {
        const { account } = await stage();
        const result = await enterTerminal(
          account.id,
          "session_expired",
          source,
        );
        expect(result.changed).toBe(true);
        expect(result.cascade).toEqual({
          membersRemoved: 2,
          messagesCancelled: 1,
          stepsSkipped: 1,
        });
        await assertCascaded(account.id, "session_expired");
      },
    );

    it("重复进入同一终态静默忽略：不报错、不再级联、不再发事件（操作员与网关事件两条路）", async () => {
      const { account, g1 } = await stage();
      await enterTerminal(account.id, "suspended", "send_error");
      const eventsBefore = await wsEvents();
      expect(eventsBefore).toHaveLength(3);
      // 期间又有新的成员行进来（比如网关的 member_joined 晚到）：重复进入不会再动它
      await getDb().groupMember.create({
        data: {
          groupId: g1.id,
          platformUserId: "pu-late",
          accountId: account.id,
        },
      });

      const viaOperator = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        { to: "suspended", expectedFrom: "suspended" },
      );
      expect(viaOperator.statusCode).toBe(200);
      expect(viaOperator.json()).toMatchObject({
        status: "suspended",
        changed: false,
        membersRemovedCount: 0,
      });
      // 操作员看到的旧状态是 online（事件先到）：目的已达成，同样静默
      const staleView = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        { to: "suspended", expectedFrom: "online" },
      );
      expect(staleView.statusCode).toBe(200);
      expect(staleView.json()).toMatchObject({ changed: false });

      const viaEvent = await enterTerminal(
        account.id,
        "suspended",
        "gateway_event",
      );
      expect(viaEvent.changed).toBe(false);

      expect(await wsEvents()).toHaveLength(eventsBefore.length);
      expect(
        await getDb().groupMember.count({ where: { accountId: account.id } }),
      ).toBe(1);
      // 终态之间没有边，但来自网关 / 发送错误的「另一个终态」不能抛错（会把调用方的记账一起回滚、事件反复失败）：
      // 静默忽略，状态保持 suspended、不再发事件
      const other = await enterTerminal(
        account.id,
        "session_expired",
        "gateway_event",
      );
      expect(other).toMatchObject({ changed: false, from: "suspended" });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("suspended");
      expect(await wsEvents()).toHaveLength(eventsBefore.length);
      // 操作员手动转移仍按转移表：终态没有出边
      const manual = await post(
        `/api/accounts/${account.id}/transition`,
        admin,
        {
          to: "session_expired",
          expectedFrom: "suspended",
        },
      );
      expect(manual.statusCode).toBe(409);
      expect(manual.json()).toMatchObject({
        error: { code: "ILLEGAL_TRANSITION" },
      });
    });
  });

  // ---- 限流 ----------------------------------------------------------------------------

  describe("rate_limited：进入、刷新、到期恢复", () => {
    it("online → rate_limited 带截止时刻；已是 rate_limited 只刷新 until，不算转移", async () => {
      const clock = fakeClock();
      const account = await accountIn("online");
      const first = await enterRateLimited(account.id, 30, { clock });
      expect(first.changed).toBe(true);
      expect(first.account.status).toBe("rate_limited");
      expect(first.account.rateLimitedUntil?.getTime()).toBe(
        clock.now().getTime() + 30_000,
      );
      expect(await wsEvents("account_status_changed")).toHaveLength(1);

      clock.advance(5_000);
      const refreshed = await enterRateLimited(account.id, 10, { clock });
      expect(refreshed.changed).toBe(false);
      expect(refreshed.account.status).toBe("rate_limited");
      expect(refreshed.account.rateLimitedUntil?.getTime()).toBe(
        clock.now().getTime() + 10_000,
      );
      // 刷新不是转移：没有新事件；但 version 变了（让并发的 CAS 知道行动过）
      expect(await wsEvents("account_status_changed")).toHaveLength(1);
      expect(refreshed.account.version).toBe(first.account.version + 1);

      // idle 账号收到 429 是不可能的组合：按转移表拒绝
      const idle = await accountIn("idle");
      await expect(
        enterRateLimited(idle.id, 5, { clock }),
      ).rejects.toMatchObject({
        code: "ILLEGAL_TRANSITION",
      });
    });

    it("到期自动回 online；未到期不动；到期前已被标离线则不转移", async () => {
      const clock = fakeClock();
      const a = await accountIn("online");
      const b = await accountIn("online");
      await enterRateLimited(a.id, 10, { clock });
      await enterRateLimited(b.id, 10, { clock });

      clock.advance(9_999);
      expect(await recoverRateLimited({ clock })).toEqual({
        due: 0,
        recovered: 0,
      });

      // b 在到期前被操作员标为 disconnected
      await transition(b.id, {
        to: "disconnected",
        expectedFrom: "rate_limited",
        source: "operator",
      });

      clock.advance(1);
      expect(await recoverRateLimited({ clock })).toEqual({
        due: 1,
        recovered: 1,
      });
      const rows = await getDb().account.findMany({ orderBy: { id: "asc" } });
      const byId = Object.fromEntries(
        rows.map((r) => [r.id, [r.status, r.rateLimitedUntil]]),
      );
      expect(byId[a.id]).toEqual(["online", null]);
      expect(byId[b.id]).toEqual(["disconnected", null]);
      expect(
        (await wsEvents("account_status_changed")).map((e) => e.payload),
      ).toContainEqual({ accountId: a.id, from: "rate_limited", to: "online" });
      // 再跑一次：没有到期的了
      expect(await recoverRateLimited({ clock })).toEqual({
        due: 0,
        recovered: 0,
      });
    });

    it("读与转移之间行被改过（expectedVersion 不符）→ CAS_CONFLICT，不转移", async () => {
      const clock = fakeClock();
      const a = await accountIn("online");
      const limited = await enterRateLimited(a.id, 1, { clock });
      clock.advance(1_000);
      // 模拟 worker 读到 version 后、转移前，网关又来一条 429 把 until 刷新了（version +1）
      await enterRateLimited(a.id, 60, { clock });
      await expect(
        transition(a.id, {
          to: "online",
          expectedFrom: "rate_limited",
          expectedVersion: limited.account.version,
          source: "rate_limit_worker",
        }),
      ).rejects.toMatchObject({ code: "CAS_CONFLICT" });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: a.id } }))
          .status,
      ).toBe("rate_limited");
    });

    describe("worker", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** 让在途的数据库 I/O 有机会完成（假定时器不假 setImmediate / socket）。 */
      async function settle(): Promise<void> {
        for (let i = 0; i < 20; i++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      it("每 tick 调恢复；到期后账号回 online；stop 立即返回", async () => {
        const clock = fakeClock();
        const a = await accountIn("online");
        await enterRateLimited(a.id, 5, { clock });

        const worker = startRateLimitWorker({
          clock,
          intervalMs: 1_000,
          log: logger.child({}, { level: "silent" }),
        });
        await settle();
        expect(
          (await getDb().account.findUniqueOrThrow({ where: { id: a.id } }))
            .status,
        ).toBe("rate_limited");

        clock.advance(5_000);
        // tick 是真库 I/O，在假定时器下完成时刻不确定：推进定时器后轮询直到落库
        let status = "rate_limited";
        for (let i = 0; i < 40 && status !== "online"; i += 1) {
          await vi.advanceTimersByTimeAsync(250);
          await settle();
          status = (
            await getDb().account.findUniqueOrThrow({ where: { id: a.id } })
          ).status;
        }
        expect(status).toBe("online");

        await worker.stop();
      });
    });
  });

  // ---- POST /api/accounts/:id/connect --------------------------------------------------

  describe("POST /api/accounts/:id/connect", () => {
    it("主流程：idle → online，保存网关给的 platformUserId；同一账号再次 connect 拿到同一个值", async () => {
      const account = await accountIn("idle");
      const res = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();
      expect(body).toMatchObject({ id: account.id, status: "online" });
      expect(typeof body.platformUserId).toBe("string");

      // 断开再连：disconnected → online，platformUserId 不变
      await post(`/api/accounts/${account.id}/transition`, admin, {
        to: "disconnected",
        expectedFrom: "online",
      });
      const again = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({
        status: "online",
        platformUserId: body.platformUserId,
      });
      expect(
        (await wsEvents("account_status_changed")).map((e) => e.payload),
      ).toEqual([
        { accountId: account.id, from: "idle", to: "online" },
        { accountId: account.id, from: "online", to: "disconnected" },
        { accountId: account.id, from: "disconnected", to: "online" },
      ]);
    });

    it("网关 403 ACCOUNT_SUSPENDED：账号进 suspended（级联）并 409 ACCOUNT_UNAVAILABLE；之后再 connect 不打网关", async () => {
      const account = await accountIn("idle");
      await getDb().groupMember.create({
        data: {
          groupId: (await makeGroup()).id,
          platformUserId: `pu-${account.id}`,
          accountId: account.id,
        },
      });
      await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "account_status",
          accountId: account.id,
          status: "suspended",
        },
      });

      const res = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "ACCOUNT_UNAVAILABLE", status: "suspended" },
      });
      const row = await getDb().account.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(row.status).toBe("suspended");
      expect(
        await getDb().groupMember.count({ where: { accountId: account.id } }),
      ).toBe(0);
      expect(
        (await wsEvents("account_terminal")).map((e) => e.payload),
      ).toEqual([{ accountId: account.id, status: "suspended" }]);

      // 本地已知终态：直接 409，网关不再收到 connect
      await gateway.inject({
        method: "POST",
        url: "/_sim/scenario",
        payload: { outage: { all: true } },
      });
      const again = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        error: { code: "ACCOUNT_UNAVAILABLE" },
      });
    });

    it("网关 401 SESSION_EXPIRED → session_expired + 409 ACCOUNT_UNAVAILABLE", async () => {
      const account = await accountIn("disconnected");
      await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "account_status",
          accountId: account.id,
          status: "session_expired",
        },
      });
      const res = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "ACCOUNT_UNAVAILABLE", status: "session_expired" },
      });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("session_expired");
    });

    it("已 online / rate_limited 的账号 connect → 409 ILLEGAL_TRANSITION；不存在 → 404", async () => {
      const online = await accountIn("online");
      const res = await post(`/api/accounts/${online.id}/connect`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "ILLEGAL_TRANSITION" },
      });

      const limited = await accountIn("rate_limited");
      const res2 = await post(`/api/accounts/${limited.id}/connect`, admin);
      expect(res2.statusCode).toBe(409);
      expect(res2.json()).toMatchObject({
        error: { code: "ILLEGAL_TRANSITION" },
      });

      const missing = await post("/api/accounts/nope/connect", admin);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: { code: "ACCOUNT_NOT_FOUND" },
      });
    });

    it("网关整体 503 → 503 GATEWAY_ERROR，本地状态不变", async () => {
      const account = await accountIn("idle");
      await gateway.inject({
        method: "POST",
        url: "/_sim/scenario",
        payload: { outage: { all: true } },
      });
      const res = await post(`/api/accounts/${account.id}/connect`, admin);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: { code: "GATEWAY_ERROR", gatewayStatus: 503 },
      });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: account.id } }))
          .status,
      ).toBe("idle");
      expect(await wsEvents()).toHaveLength(0);
    });
  });
});
