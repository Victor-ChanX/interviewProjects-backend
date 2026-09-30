// issue #15：定时序列（题目 B1、2.3 sequences / sequence-runs 端点、WS sequence_run、S8；A1 终态级联 → skipped、
// A2 RATE_LIMITED → 顺延、GROUP_WRITE_FORBIDDEN → stopped、重启只重排一步）。
// 真库（tests/setup.ts 的临时 schema）；网关用 src/sim/gateway 的 buildGatewayApp 起在 listen(0) 上，出站 worker
// 经 createGatewayClient 走真 HTTP。时间：应用、service、worker 与网关模拟器共用一个可拨动的假 Clock。
// worker 不起循环：直接 await runSequenceTick()（一个 tick = 领取到点的 run 并推进）；出站派发 await runOutboxTick()；
// message_sent / message_failed 由 #8 的入站流消费，这里用 factories 的 deliverGatewayReceipt 模拟它。
// 多连接真并行的并发启动用例在 tests/sequences-concurrency.test.ts。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { Invalid } from "../src/core/errors.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type {
  Account,
  AccountStatus,
  Group,
  MemberRole,
} from "../src/db/generated/client.js";
import type { SequenceStepDefinition } from "../src/schemas/sequence.js";
import { enterTerminal } from "../src/services/account-service.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { markGroupUnreachableInTx } from "../src/services/group-service.js";
import {
  createSequence,
  NO_ACCOUNT_FAIL_CODE,
  RATE_LIMIT_RECHECK_MS,
  renderTemplate,
  resolveVars,
  startRun,
} from "../src/services/sequence-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { runOutboxTick } from "../src/workers/outbox-worker.js";
import { runSequenceTick } from "../src/workers/sequence-worker.js";
import {
  deliverGatewayReceipt,
  loginAs,
  makeAccount,
  makeGroup,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

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

const silent = logger.child({}, { level: "silent" });

/** 题目 B1 的示例序列 + 第 3 步（三种取值路径都能覆盖） */
const STEPS: SequenceStepDefinition[] = [
  {
    index: 1,
    accountRole: "admin",
    text: "{event} 将于 {time} 开始，请提前准备",
    delaySeconds: 10,
  },
  {
    index: 2,
    accountRole: "member",
    text: "提醒：{event} 的资料已上传到 {location}",
    delaySeconds: 5,
  },
  {
    index: 3,
    accountRole: "admin",
    text: "{event} 结束，资料仍在 {location}",
    delaySeconds: 3,
  },
];
const VARS = { event: "季度评审", time: "14:00", location: "共享盘/默认" };

const sec = (n: number): number => n * 1_000;

// ---- 取值链：纯函数，不需要库 -----------------------------------------------------------------

describe("resolveVars（B1 取值规则）", () => {
  it("只有 vars：每步只含自己文本里的 key，来源都是 default", () => {
    const out = resolveVars(STEPS, VARS, {});
    expect(out).toEqual([
      {
        index: 1,
        resolvedVars: { event: "季度评审", time: "14:00" },
        varSources: { event: "default", time: "default" },
      },
      {
        index: 2,
        resolvedVars: { event: "季度评审", location: "共享盘/默认" },
        varSources: { event: "default", location: "default" },
      },
      {
        index: 3,
        resolvedVars: { event: "季度评审", location: "共享盘/默认" },
        varSources: { event: "default", location: "default" },
      },
    ]);
  });

  it("第 k 步给了值：从该步起沿用，来源标最初给出它的那一步；更晚的步再给就换", () => {
    const out = resolveVars(STEPS, VARS, {
      "2": { location: "共享盘/第二季度" },
    });
    expect(out[0]!.resolvedVars).toEqual({ event: "季度评审", time: "14:00" });
    expect(out[1]!.resolvedVars.location).toBe("共享盘/第二季度");
    expect(out[1]!.varSources.location).toBe("step:2");
    // 第 3 步没给，沿用第 2 步的值，来源仍标 step:2
    expect(out[2]!.resolvedVars.location).toBe("共享盘/第二季度");
    expect(out[2]!.varSources.location).toBe("step:2");

    const again = resolveVars(STEPS, VARS, {
      "2": { location: "B" },
      "3": { location: "C" },
    });
    expect(again[1]!.resolvedVars.location).toBe("B");
    expect(again[2]!.resolvedVars.location).toBe("C");
    expect(again[2]!.varSources.location).toBe("step:3");
  });

  it('stepVars 里的 "" 表示这一步不改；vars 里的 "" 视为未提供', () => {
    const keep = resolveVars(STEPS, VARS, { "2": { location: "" } });
    expect(keep[1]!.resolvedVars.location).toBe("共享盘/默认");
    expect(keep[1]!.varSources.location).toBe("default");

    // vars.location = ""：第 2 步由 stepVars 补上，第 3 步沿用第 2 步
    const fromStep = resolveVars(
      STEPS,
      { ...VARS, location: "" },
      { "2": { location: "X" } },
    );
    expect(fromStep[1]!.varSources.location).toBe("step:2");
    expect(fromStep[2]!.resolvedVars.location).toBe("X");
  });

  it("早的步给了后面才用到的 key：后面那步的来源标最初给出它的那一步；指向不存在的步的 stepVars 被忽略", () => {
    const out = resolveVars(
      STEPS,
      { event: "E", time: "T" },
      { "1": { location: "L1" }, "9": { location: "never" } },
    );
    expect(out[1]!.resolvedVars.location).toBe("L1");
    expect(out[1]!.varSources.location).toBe("step:1");
    expect(out[2]!.varSources.location).toBe("step:1");
  });

  it("原型链上的名字不算有值：{constructor} / {toString} / {__proto__} 没提供就是解析不到；提供了照常取值", () => {
    for (const key of ["constructor", "toString", "__proto__"]) {
      const steps = [{ index: 1, text: `hi {${key}}` }];
      expect(() => resolveVars(steps, {}, {})).toThrow(
        expect.objectContaining({
          code: "UNRESOLVED_PLACEHOLDER",
          extra: { stepIndex: 1, key },
        }),
      );
      const vars = JSON.parse(`{"${key}":"v-${key}"}`) as Record<
        string,
        string
      >;
      const [out] = resolveVars(steps, vars, {});
      expect(out!.resolvedVars[key]).toBe(`v-${key}`);
      expect(renderTemplate(steps[0]!.text, out!.resolvedVars)).toBe(
        `hi v-${key}`,
      );
    }
    expect(renderTemplate("hi {constructor}", {})).toBe("hi {constructor}");
  });

  it("解析不到 → Invalid UNRESOLVED_PLACEHOLDER，extra 带 stepIndex 与 key（按步序报第一个）", () => {
    const attempt = () => resolveVars(STEPS, { event: "E", time: "T" }, {});
    expect(attempt).toThrow(Invalid);
    try {
      attempt();
    } catch (err) {
      expect(err).toMatchObject({
        statusCode: 422,
        code: "UNRESOLVED_PLACEHOLDER",
        extra: { stepIndex: 2, key: "location" },
      });
    }
    // 空串等于没给
    expect(() =>
      resolveVars(STEPS, { event: "E", time: "", location: "L" }, {}),
    ).toThrow(
      expect.objectContaining({ extra: { stepIndex: 1, key: "time" } }),
    );
  });
});

// ---- 端点 + 排期 + worker：真库 + 网关模拟器 -------------------------------------------------------

describe("定时序列（#15）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
  /** 「worker 早就在跑」的启动时刻：每个用例开头取，之后排定的步都晚于它，不触发重启重排 */
  let workerStartedAt: Date;

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
    workerStartedAt = clock.now();
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    await gateway.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload: { send: { acceptDelayMs: 0, eventDelayMs: 0 } },
    });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await gateway.close();
    await closeDb();
  });

  // ---- 辅助 ------------------------------------------------------------------------

  const simSendCalls = async (): Promise<Json[]> =>
    (await gateway.inject({ method: "GET", url: "/_sim/state" })).json<{
      sendCalls: Json[];
    }>().sendCalls;

  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  /** 一个在线账号当群主建一个群（本地 + 网关），本地成员表写入群主（role = creator） */
  async function _stageGroup(): Promise<{ group: Group; creator: Account }> {
    const creatorId = `acc-c-${randomUUID().slice(0, 6)}`;
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

  /** 再加一个成员账号（网关 connect + 网关入群 + 本地成员行） */
  async function _addMember(
    group: Group,
    opts: {
      id?: string;
      role?: MemberRole;
      status?: AccountStatus;
      rateLimitedUntil?: Date;
    } = {},
  ): Promise<Account> {
    const id = opts.id ?? `acc-m-${randomUUID().slice(0, 6)}`;
    const platformUserId = await connectAtGateway(id);
    const account = await makeAccount({
      id,
      status: opts.status ?? "online",
      platformUserId,
      ...(opts.rateLimitedUntil
        ? { rateLimitedUntil: opts.rateLimitedUntil }
        : {}),
    });
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
    await getDb().groupMember.create({
      data: {
        groupId: group.id,
        platformUserId,
        accountId: id,
        role: opts.role ?? "member",
      },
    });
    return account;
  }

  const _makeSequence = (steps: SequenceStepDefinition[] = STEPS) =>
    createSequence({ name: `seq-${randomUUID().slice(0, 6)}`, steps });

  /**
   * 启动一次运行（走 service，注入假时钟：排期断言要精确到毫秒；端点本身的契约在「POST /api/groups/:id/sequence-runs」
   * 一组用例里走 app.inject，那里的路由用系统时钟）。返回 runId。
   */
  async function _start(
    group: Group,
    payload: { stepVars?: Record<string, Record<string, string>> } = {},
    steps: SequenceStepDefinition[] = STEPS,
  ): Promise<string> {
    const { id } = await _makeSequence(steps);
    const { runId } = await startRun(
      group.id,
      { sequenceId: id, vars: VARS, stepVars: payload.stepVars ?? {} },
      { clock, log: silent },
    );
    return runId;
  }

  const tick = (startedAt: Date = workerStartedAt) =>
    runSequenceTick({ clock, log: silent, workerStartedAt: startedAt });
  const outboxTick = () =>
    runOutboxTick({
      clock,
      gateway: gatewayClient,
      workerId: "w1",
      log: silent,
    });

  const run = (id: string) =>
    getDb().sequenceRun.findUniqueOrThrow({
      where: { id },
      include: { steps: { orderBy: { index: "asc" } } },
    });
  const stepOf = async (runId: string, index: number) =>
    getDb().sequenceRunStep.findUniqueOrThrow({
      where: { runId_index: { runId, index } },
    });
  const runEvents = async () =>
    (
      await getDb().wsEvent.findMany({
        where: { type: "sequence_run" },
        orderBy: { id: "asc" },
      })
    ).map((e) => e.payload as Json);

  /** 模拟网关 message_sent（#8 的入站流会调同一个入口） */
  const sent = (clientMsgId: string, at: Date) =>
    deliverGatewayReceipt(
      { clientMsgId, msgId: `m-${randomUUID().slice(0, 6)}`, sentAt: at },
      { clock, log: silent },
    );

  // ---- POST /api/sequences --------------------------------------------------------

  describe("POST /api/sequences", () => {
    it("admin 201 { id }，原样存 steps；GET /api/sequences 列得出来", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sequences",
        headers: admin,
        payload: { name: "欢迎序列", steps: STEPS },
      });
      expect(res.statusCode).toBe(201);
      const { id } = res.json<{ id: string }>();
      const row = await getDb().sequence.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe("欢迎序列");
      expect(row.steps).toEqual(STEPS);

      const list = await app.inject({
        method: "GET",
        url: "/api/sequences",
        headers: viewer,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({
        total: 1,
        items: [{ id, name: "欢迎序列", steps: STEPS }],
      });
    });

    it("viewer 403 FORBIDDEN，不落库", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sequences",
        headers: viewer,
        payload: { name: "x", steps: STEPS },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      expect(await getDb().sequence.count()).toBe(0);
    });

    it.each([
      ["index 不连续", [{ ...STEPS[0]!, index: 2 }]],
      ["index 乱序", [STEPS[1]!, STEPS[0]!]],
      ["delaySeconds 为负", [{ ...STEPS[0]!, delaySeconds: -1 }]],
      ["steps 为空", []],
    ])("形状错（%s）→ 400 VALIDATION_ERROR", async (_name, steps) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sequences",
        headers: admin,
        payload: { name: "x", steps },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });
  });

  // ---- POST /api/groups/:id/sequence-runs ------------------------------------------

  describe("POST /api/groups/:id/sequence-runs", () => {
    it("主流程：201 { runId }；run running、全部步骤 pending 带取值快照、只有第 1 步排了期（now + delay1）；ws sequence_run；群的 activeSequenceRunId", async () => {
      const { group } = await _stageGroup();
      const { id } = await _makeSequence();
      const before = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/sequence-runs`,
        headers: admin,
        payload: {
          sequenceId: id,
          vars: VARS,
          stepVars: { "2": { location: "共享盘/第二季度" } },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const { runId } = res.json<{ runId: string }>();
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);

      const r = await run(runId);
      expect(r).toMatchObject({
        sequenceId: id,
        groupId: group.id,
        status: "running",
        currentStepIndex: 1,
        vars: VARS,
        stepVars: { "2": { location: "共享盘/第二季度" } },
        finishedAt: null,
      });
      expect(r.steps.map((s) => s.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      // 路由用系统时钟：第 1 步 = 受理时刻 + 10s（毫秒级精确断言在「排期」一组里用注入的假时钟做）
      const scheduled1 = r.steps[0]!.scheduledAt!.getTime();
      expect(scheduled1).toBeGreaterThanOrEqual(before + sec(10));
      expect(scheduled1).toBeLessThanOrEqual(Date.now() + sec(10));
      expect(r.steps[1]!.scheduledAt).toBeNull();
      expect(r.steps[2]!.scheduledAt).toBeNull();
      expect(r.steps[1]).toMatchObject({
        accountRole: "member",
        template: STEPS[1]!.text,
        delaySeconds: 5,
        resolvedVars: { event: "季度评审", location: "共享盘/第二季度" },
        varSources: { event: "default", location: "step:2" },
        clientMsgId: null,
        accountId: null,
      });
      expect(r.steps[2]!.varSources).toEqual({
        event: "default",
        location: "step:2",
      });
      expect(await runEvents()).toEqual([
        { runId, groupId: group.id, status: "running", currentStepIndex: 1 },
      ]);

      const detail = await app.inject({
        method: "GET",
        url: `/api/groups/${group.id}`,
        headers: viewer,
      });
      expect(detail.json()).toMatchObject({ activeSequenceRunId: runId });
      // 201 只保证落库：网关还没收到任何东西
      expect(await simSendCalls()).toHaveLength(0);
    });

    it("viewer 403；群不存在 404 GROUP_NOT_FOUND；序列不存在 422 SEQUENCE_NOT_FOUND；群不可写 409 GROUP_UNREACHABLE", async () => {
      const { group } = await _stageGroup();
      const { id } = await _makeSequence();
      const post = (
        groupId: string,
        headers: Record<string, string>,
        sequenceId = id,
      ) =>
        app.inject({
          method: "POST",
          url: `/api/groups/${groupId}/sequence-runs`,
          headers,
          payload: { sequenceId, vars: VARS },
        });

      const forbidden = await post(group.id, viewer);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      const missing = await post("nope", admin);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: { code: "GROUP_NOT_FOUND" },
      });

      const noSeq = await post(group.id, admin, "nope");
      expect(noSeq.statusCode).toBe(422);
      expect(noSeq.json()).toMatchObject({
        error: { code: "SEQUENCE_NOT_FOUND", sequenceId: "nope" },
      });

      await getDb().group.update({
        where: { id: group.id },
        data: { status: "unreachable" },
      });
      const unreachable = await post(group.id, admin);
      expect(unreachable.statusCode).toBe(409);
      expect(unreachable.json()).toMatchObject({
        error: { code: "GROUP_UNREACHABLE", status: "unreachable" },
      });
      expect(await getDb().sequenceRun.count()).toBe(0);
    });

    it("S8 预检：第 3 步解析不到 → 422 UNRESOLVED_PLACEHOLDER stepIndex = 3 key；一条不发、不留记录；之后可正常启动", async () => {
      const { group } = await _stageGroup();
      const steps: SequenceStepDefinition[] = [
        STEPS[0]!,
        { ...STEPS[1]!, text: "提醒：{event} 的资料已上传" },
        { ...STEPS[2]!, text: "{event} 结束，会议室 {room}" },
      ];
      const { id } = await _makeSequence(steps);
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/sequence-runs`,
        headers: admin,
        payload: { sequenceId: id, vars: { event: "E", time: "T" } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: {
          code: "UNRESOLVED_PLACEHOLDER",
          stepIndex: 3,
          key: "room",
        },
      });
      expect(typeof res.json<{ error: Json }>().error.requestId).toBe("string");
      expect(await getDb().sequenceRun.count()).toBe(0);
      expect(await getDb().sequenceRunStep.count()).toBe(0);
      expect(await getDb().wsEvent.count()).toBe(0);
      // 把时间拨过第 1 步的 delay 再 tick：没有 run，网关一条都收不到
      clock.advance(sec(60));
      await tick();
      await outboxTick();
      expect(await simSendCalls()).toHaveLength(0);

      // 补上 room 就能启动
      const ok = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/sequence-runs`,
        headers: admin,
        payload: {
          sequenceId: id,
          vars: { event: "E", time: "T" },
          stepVars: { "3": { room: "301" } },
        },
      });
      expect(ok.statusCode).toBe(201);
      const s3 = await stepOf(ok.json<{ runId: string }>().runId, 3);
      expect(s3.resolvedVars).toEqual({ event: "E", room: "301" });
      expect(s3.varSources).toEqual({ event: "default", room: "step:3" });
    });

    it("同群已有 running → 409 SEQUENCE_ALREADY_RUNNING；finished 之后可以再启动", async () => {
      const { group } = await _stageGroup();
      const first = await _start(group);
      const { id } = await _makeSequence();
      const res = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/sequence-runs`,
        headers: admin,
        payload: { sequenceId: id, vars: VARS },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: "SEQUENCE_ALREADY_RUNNING", groupId: group.id },
      });
      expect(await getDb().sequenceRun.count()).toBe(1);

      await getDb().sequenceRun.update({
        where: { id: first },
        data: { status: "finished", finishedAt: clock.now() },
      });
      const again = await app.inject({
        method: "POST",
        url: `/api/groups/${group.id}/sequence-runs`,
        headers: admin,
        payload: { sequenceId: id, vars: VARS },
      });
      expect(again.statusCode).toBe(201);
    });
  });

  // ---- 排期与发送 -------------------------------------------------------------------

  describe("排期：以 message_sent 为基准", () => {
    it("主流程：第 1 步在启动后 delay1 秒入队并发到网关；第 n 步在第 n-1 步 sent 后 delay 秒；最后一步 sent → finished", async () => {
      const { group, creator } = await _stageGroup();
      const member = await _addMember(group, { id: "acc-m-only" });
      const runId = await _start(group);

      // 没到点：不动
      clock.advance(sec(10) - 1);
      expect((await tick()).advanced).toBe(0);
      expect((await stepOf(runId, 1)).status).toBe("pending");

      // 到点：入队（accepted + clientMsgId），文本已按取值渲染；网关此时还没收到（202 由出站 worker 拿）
      clock.advance(1);
      const t1 = await tick();
      expect(t1.results).toEqual([
        { runId, stepIndex: 1, outcome: "enqueued" },
      ]);
      const s1 = await stepOf(runId, 1);
      expect(s1).toMatchObject({ status: "accepted", accountId: creator.id });
      expect(s1.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
      const m1 = await getDb().message.findUniqueOrThrow({
        where: { clientMsgId: s1.clientMsgId! },
      });
      expect(m1).toMatchObject({
        groupId: group.id,
        accountId: creator.id,
        text: "季度评审 将于 14:00 开始，请提前准备",
        deliveryStatus: "queued",
        isOwn: true,
      });
      expect(await simSendCalls()).toHaveLength(0);
      // 在途：再 tick 什么都不做
      expect((await tick()).advanced).toBe(0);

      // 出站 worker 发到网关：202 → accepted；序列步骤仍 accepted（还没 sent）
      await outboxTick();
      expect(await simSendCalls()).toMatchObject([
        { accountId: creator.id, clientMsgId: s1.clientMsgId, status: 202 },
      ]);
      expect((await run(runId)).currentStepIndex).toBe(1);

      // message_sent：第 1 步 sent；「发出」= 收到 message_sent 的时刻（B1），不是网关报的 sentAt ——
      // 这里网关时钟慢 1 秒；第 2 步排到收到时刻 + 5s；进度到 2
      clock.advance(sec(2));
      const sentAt1 = clock.now();
      await sent(s1.clientMsgId!, new Date(sentAt1.getTime() - sec(1)));
      let r = await run(runId);
      expect(r.currentStepIndex).toBe(2);
      expect(r.steps[0]).toMatchObject({ status: "sent", sentAt: sentAt1 });
      expect(r.steps[1]!.scheduledAt?.getTime()).toBe(
        sentAt1.getTime() + sec(5),
      );
      expect(r.steps[2]!.scheduledAt).toBeNull();

      // 第 2 步：member 发；差 1ms 不发，到点才发
      clock.advance(sec(5) - 1);
      expect((await tick()).advanced).toBe(0);
      clock.advance(1);
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 2, outcome: "enqueued" },
      ]);
      const s2 = await stepOf(runId, 2);
      expect(s2).toMatchObject({ status: "accepted", accountId: member.id });
      await outboxTick();
      const sentAt2 = clock.now();
      await sent(s2.clientMsgId!, sentAt2);
      r = await run(runId);
      expect(r.currentStepIndex).toBe(3);
      expect(r.steps[2]!.scheduledAt?.getTime()).toBe(
        sentAt2.getTime() + sec(3),
      );

      // 第 3 步：最后一步 sent → run finished
      clock.advance(sec(3));
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 3, outcome: "enqueued" },
      ]);
      const s3 = await stepOf(runId, 3);
      await outboxTick();
      const sentAt3 = clock.now();
      await sent(s3.clientMsgId!, sentAt3);
      r = await run(runId);
      expect(r).toMatchObject({
        status: "finished",
        currentStepIndex: 3,
        finishedAt: clock.now(),
      });
      expect(r.steps.map((s) => s.status)).toEqual(["sent", "sent", "sent"]);
      expect(await simSendCalls()).toHaveLength(3);
      expect(await runEvents()).toEqual([
        { runId, groupId: group.id, status: "running", currentStepIndex: 1 },
        { runId, groupId: group.id, status: "running", currentStepIndex: 2 },
        { runId, groupId: group.id, status: "running", currentStepIndex: 3 },
        { runId, groupId: group.id, status: "finished", currentStepIndex: 3 },
      ]);
      // 结束后群不再有 activeSequenceRunId；再 tick 无事
      const detail = await app.inject({
        method: "GET",
        url: `/api/groups/${group.id}`,
        headers: viewer,
      });
      expect(detail.json()).toMatchObject({ activeSequenceRunId: null });
      expect((await tick()).advanced).toBe(0);
    });

    it("message_sent 重复推送是空操作：步骤不会被改两次、下一步排期不变", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      const sentAt = clock.now();
      await sent(s1.clientMsgId!, sentAt);
      const first = await run(runId);
      clock.advance(sec(1));
      await sent(s1.clientMsgId!, clock.now());
      const second = await run(runId);
      expect(second.steps[1]!.scheduledAt).toEqual(first.steps[1]!.scheduledAt);
      expect(second.steps[0]!.sentAt).toEqual(sentAt);
      expect(second.currentStepIndex).toBe(2);
    });
  });

  describe("选账号", () => {
    it("admin：优先 role = admin，再 creator；同角色按 accountId 字典序", async () => {
      const { group, creator } = await _stageGroup();
      const adminB = await _addMember(group, {
        id: "acc-adm-b",
        role: "admin",
      });
      const adminA = await _addMember(group, {
        id: "acc-adm-a",
        role: "admin",
      });
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      expect((await stepOf(runId, 1)).accountId).toBe(adminA.id);

      // 两个 admin 都不在线 → creator
      await getDb().account.updateMany({
        where: { id: { in: [adminA.id, adminB.id] } },
        data: { status: "disconnected" },
      });
      const s1 = await stepOf(runId, 1);
      await sent(s1.clientMsgId!, clock.now());
      // 第 2 步是 member：没有 member → skipped，进度到第 3 步（admin）
      clock.advance(sec(5));
      await tick();
      clock.advance(sec(3));
      await tick();
      expect(await stepOf(runId, 3)).toMatchObject({
        status: "accepted",
        accountId: creator.id,
      });
    });

    it("member：role = member 且 online 按 accountId 字典序取第一个；不在线的不算", async () => {
      const { group } = await _stageGroup();
      await _addMember(group, { id: "acc-m-c" });
      await _addMember(group, { id: "acc-m-a", status: "disconnected" });
      const b = await _addMember(group, { id: "acc-m-b" });
      const runId = await _start(group, {}, [
        { ...STEPS[1]!, index: 1, delaySeconds: 0 },
      ]);
      await tick();
      expect(await stepOf(runId, 1)).toMatchObject({
        status: "accepted",
        accountId: b.id,
      });
    });

    it("没有匹配账号 → skipped（skippedAt = 此刻、failCode），视为此刻发出：下一步排到 skippedAt + delay，进度照常推进", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      await sent(s1.clientMsgId!, clock.now());
      clock.advance(sec(5));
      const at = clock.now();
      const t = await tick();
      expect(t.results).toEqual([{ runId, stepIndex: 2, outcome: "skipped" }]);
      const r = await run(runId);
      expect(r.currentStepIndex).toBe(3);
      expect(r.steps[1]).toMatchObject({
        status: "skipped",
        skippedAt: at,
        failCode: NO_ACCOUNT_FAIL_CODE,
        clientMsgId: null,
        accountId: null,
      });
      expect(r.steps[2]!.scheduledAt?.getTime()).toBe(at.getTime() + sec(3));
      expect(await getDb().message.count()).toBe(1);

      // 最后一步 skipped → run finished
      await getDb().groupMember.deleteMany({ where: { groupId: group.id } });
      clock.advance(sec(3));
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 3, outcome: "skipped" },
      ]);
      expect((await run(runId)).status).toBe("finished");
    });

    it("rate_limited 不算没有：该步顺延到限流结束（scheduledAt = rateLimitedUntil），到期后发出", async () => {
      const { group } = await _stageGroup();
      const until = new Date(clock.now().getTime() + sec(30));
      const limited = await _addMember(group, {
        id: "acc-m-lim",
        status: "rate_limited",
        rateLimitedUntil: until,
      });
      const runId = await _start(group, {}, [
        { ...STEPS[1]!, index: 1, delaySeconds: 0 },
        { ...STEPS[2]!, index: 2 },
      ]);
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 1, outcome: "deferred" },
      ]);
      let s1 = await stepOf(runId, 1);
      expect(s1).toMatchObject({ status: "pending", scheduledAt: until });
      expect(await getDb().message.count()).toBe(0);

      // 到期前不动
      clock.advance(sec(29));
      expect((await tick()).advanced).toBe(0);
      // 到期了但恢复 worker 还没把它转回 online：再顺延 RATE_LIMIT_RECHECK_MS，不跳过
      clock.advance(sec(1));
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 1, outcome: "deferred" },
      ]);
      s1 = await stepOf(runId, 1);
      expect(s1.scheduledAt?.getTime()).toBe(
        clock.now().getTime() + RATE_LIMIT_RECHECK_MS,
      );
      // 恢复 online 后发出
      await getDb().account.update({
        where: { id: limited.id },
        data: { status: "online", rateLimitedUntil: null },
      });
      clock.advance(RATE_LIMIT_RECHECK_MS);
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 1, outcome: "enqueued" },
      ]);
      expect((await stepOf(runId, 1)).accountId).toBe(limited.id);
    });

    it("有 online 的就用 online 的，不等 rate_limited 的 admin", async () => {
      const { group, creator } = await _stageGroup();
      await _addMember(group, {
        id: "acc-adm-lim",
        role: "admin",
        status: "rate_limited",
        rateLimitedUntil: new Date(clock.now().getTime() + sec(30)),
      });
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      expect(await stepOf(runId, 1)).toMatchObject({
        status: "accepted",
        accountId: creator.id,
      });
    });
  });

  describe("消息终局与级联", () => {
    it("message_failed → 步骤 failed（failCode = 网关码），下一步以此刻为基准继续", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      clock.advance(sec(1));
      const at = clock.now();
      await deliverGatewayReceipt(
        { clientMsgId: s1.clientMsgId!, code: "SENDER_NOT_IN_GROUP" },
        { clock, log: silent },
      );
      const r = await run(runId);
      expect(r.steps[0]).toMatchObject({
        status: "failed",
        failCode: "SENDER_NOT_IN_GROUP",
        sentAt: null,
      });
      expect(r.currentStepIndex).toBe(2);
      expect(r.steps[1]!.scheduledAt?.getTime()).toBe(at.getTime() + sec(5));
    });

    it("账号进终态：排队中的消息 cancelled、对应步骤 skipped（A1）；worker 据 skippedAt 排下一步", async () => {
      const { group } = await _stageGroup();
      const member = await _addMember(group, { id: "acc-m-x" });
      const runId = await _start(group, {}, [
        { ...STEPS[1]!, index: 1, delaySeconds: 0 },
        { ...STEPS[2]!, index: 2 },
      ]);
      await tick();
      const s1 = await stepOf(runId, 1);
      expect(s1.status).toBe("accepted");
      clock.advance(sec(2));
      const at = clock.now();
      await enterTerminal(member.id, "suspended", "operator", {
        clock,
        log: silent,
      });
      const m = await getDb().message.findUniqueOrThrow({
        where: { clientMsgId: s1.clientMsgId! },
      });
      expect(m).toMatchObject({
        deliveryStatus: "cancelled",
        failCode: "ACCOUNT_TERMINAL",
      });
      let r = await run(runId);
      expect(r.steps[0]).toMatchObject({
        status: "skipped",
        skippedAt: at,
        failCode: "ACCOUNT_TERMINAL",
      });
      // 级联只改步骤；下一次 tick 才按 skippedAt + delay 排第 2 步
      expect(r.currentStepIndex).toBe(1);
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 1, outcome: "progressed" },
      ]);
      r = await run(runId);
      expect(r.currentStepIndex).toBe(2);
      expect(r.steps[1]!.scheduledAt?.getTime()).toBe(at.getTime() + sec(3));
      // 出站 worker 不会再发它
      await outboxTick();
      expect(await simSendCalls()).toHaveLength(0);
    });

    it("群不可写（GROUP_WRITE_FORBIDDEN）→ run stopped + ws sequence_run；之后 tick 不再推进、也不再发", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      await sent(s1.clientMsgId!, clock.now());
      const result = await getDb().$transaction((tx) =>
        markGroupUnreachableInTx(
          tx,
          group.id,
          "GROUP_WRITE_FORBIDDEN",
          clock.now(),
        ),
      );
      expect(result.sequenceRunsStopped).toBe(1);
      const r = await run(runId);
      expect(r).toMatchObject({
        status: "stopped",
        currentStepIndex: 2,
        finishedAt: clock.now(),
      });
      expect((await runEvents()).at(-1)).toEqual({
        runId,
        groupId: group.id,
        status: "stopped",
        currentStepIndex: 2,
      });
      clock.advance(sec(60));
      expect((await tick()).advanced).toBe(0);
      expect((await stepOf(runId, 2)).status).toBe("pending");
      expect(await getDb().message.count()).toBe(1);
      const detail = await app.inject({
        method: "GET",
        url: `/api/groups/${group.id}`,
        headers: viewer,
      });
      expect(detail.json()).toMatchObject({ activeSequenceRunId: null });
    });

    it("群不可写时步骤的消息还在排队：消息 cancelled，步骤随之 failed GROUP_UNREACHABLE（不停在 accepted）", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      expect(s1.status).toBe("accepted");
      await getDb().$transaction((tx) =>
        markGroupUnreachableInTx(
          tx,
          group.id,
          "GROUP_WRITE_FORBIDDEN",
          clock.now(),
        ),
      );
      expect(await stepOf(runId, 1)).toMatchObject({
        status: "failed",
        failCode: "GROUP_UNREACHABLE",
      });
      expect((await run(runId)).status).toBe("stopped");
    });

    it("推进时群已 left（leave-all 之后）→ run failed", async () => {
      const { group } = await _stageGroup();
      const runId = await _start(group);
      await getDb().group.update({
        where: { id: group.id },
        data: { status: "left" },
      });
      clock.advance(sec(10));
      expect((await tick()).results).toEqual([
        { runId, stepIndex: 1, outcome: "run_ended" },
      ]);
      expect((await run(runId)).status).toBe("failed");
      expect((await runEvents()).at(-1)).toMatchObject({ status: "failed" });
    });
  });

  // ---- 重启恢复 ---------------------------------------------------------------------

  describe("重启恢复：只重排最早一个已过期的步骤", () => {
    /** 跑到第 2 步已排期的状态：第 1 步 sent 于 sentAt1，第 2 步 scheduledAt = sentAt1 + 5s */
    async function _atStep2(): Promise<{ runId: string; scheduled2: Date }> {
      const { group } = await _stageGroup();
      await _addMember(group, { id: "acc-m-r" });
      const runId = await _start(group);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      const sentAt1 = clock.now();
      await sent(s1.clientMsgId!, sentAt1);
      const scheduled2 = (await stepOf(runId, 2)).scheduledAt!;
      expect(scheduled2.getTime()).toBe(sentAt1.getTime() + sec(5));
      return { runId, scheduled2 };
    }

    it("停机期间第 2 步过期：新 worker 接手时只把第 2 步改到「重启时刻 + delay2」，不发；第 3 步仍等第 2 步发出后 delay3", async () => {
      const { runId, scheduled2 } = await _atStep2();
      // 停机一小时后进程回来
      clock.advance(sec(3_600));
      const restartedAt = clock.now();
      expect(scheduled2.getTime()).toBeLessThan(restartedAt.getTime());

      const first = await tick(restartedAt);
      expect(first.results).toEqual([
        { runId, stepIndex: 2, outcome: "rescheduled" },
      ]);
      let r = await run(runId);
      expect(r.steps[1]).toMatchObject({
        status: "pending",
        clientMsgId: null,
      });
      expect(r.steps[1]!.scheduledAt?.getTime()).toBe(
        restartedAt.getTime() + sec(5),
      );
      expect(r.steps[2]!.scheduledAt).toBeNull();
      expect(await getDb().message.count()).toBe(1);
      // 只重排一次：再 tick 不会再推
      expect((await tick(restartedAt)).advanced).toBe(0);

      // 到新的排期才发第 2 步；第 3 步按第 2 步 sent 后 + 3s，不是一次性全发
      clock.advance(sec(5) - 1);
      expect((await tick(restartedAt)).advanced).toBe(0);
      clock.advance(1);
      expect((await tick(restartedAt)).results).toEqual([
        { runId, stepIndex: 2, outcome: "enqueued" },
      ]);
      const s2 = await stepOf(runId, 2);
      clock.advance(sec(1));
      const sentAt2 = clock.now();
      await sent(s2.clientMsgId!, sentAt2);
      r = await run(runId);
      expect(r.currentStepIndex).toBe(3);
      expect(r.steps[2]!.scheduledAt?.getTime()).toBe(
        sentAt2.getTime() + sec(3),
      );
      expect((await tick(restartedAt)).advanced).toBe(0);
      expect(await getDb().message.count()).toBe(2);
    });

    it("没有停机（worker 早于排期启动）：到点就发，不重排", async () => {
      const { runId, scheduled2 } = await _atStep2();
      clock.advance(sec(3_600));
      expect((await tick(workerStartedAt)).results).toEqual([
        { runId, stepIndex: 2, outcome: "enqueued" },
      ]);
      const s2 = await stepOf(runId, 2);
      expect(s2.status).toBe("accepted");
      expect(s2.scheduledAt).toEqual(scheduled2);
    });

    it("停机时第 2 步还没到点：不算过期，按原排期发", async () => {
      const { runId, scheduled2 } = await _atStep2();
      clock.advance(sec(2));
      const restartedAt = clock.now();
      expect((await tick(restartedAt)).advanced).toBe(0);
      clock.advance(sec(3));
      expect((await tick(restartedAt)).results).toEqual([
        { runId, stepIndex: 2, outcome: "enqueued" },
      ]);
      expect((await stepOf(runId, 2)).scheduledAt).toEqual(scheduled2);
    });
  });

  // ---- GET /api/sequence-runs/:id ------------------------------------------------------

  describe("GET /api/sequence-runs/:id", () => {
    it("题目形状：{ status, currentStepIndex, steps[{ index, status, scheduledAt, sentAt, clientMsgId, resolvedVars, varSources }] }；viewer 可读", async () => {
      const { group, creator } = await _stageGroup();
      const runId = await _start(group, {
        stepVars: { "2": { location: "共享盘/第二季度" } },
      });
      const scheduled1 = clock.now().getTime() + sec(10);
      clock.advance(sec(10));
      await tick();
      const s1 = await stepOf(runId, 1);
      const sentAt1 = clock.now();
      await sent(s1.clientMsgId!, sentAt1);

      const res = await app.inject({
        method: "GET",
        url: `/api/sequence-runs/${runId}`,
        headers: viewer,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();
      expect(typeof body.sequenceId).toBe("string");
      expect(typeof body.createdAt).toBe("string");
      const rest = { ...body };
      delete rest.sequenceId;
      delete rest.createdAt;
      expect(rest).toEqual({
        id: runId,
        groupId: group.id,
        status: "running",
        currentStepIndex: 2,
        finishedAt: null,
        steps: [
          {
            index: 1,
            status: "sent",
            accountRole: "admin",
            delaySeconds: 10,
            scheduledAt: new Date(scheduled1).toISOString(),
            sentAt: sentAt1.toISOString(),
            skippedAt: null,
            accountId: creator.id,
            clientMsgId: s1.clientMsgId,
            failCode: null,
            resolvedVars: { event: "季度评审", time: "14:00" },
            varSources: { event: "default", time: "default" },
          },
          {
            index: 2,
            status: "pending",
            accountRole: "member",
            delaySeconds: 5,
            scheduledAt: new Date(sentAt1.getTime() + sec(5)).toISOString(),
            sentAt: null,
            skippedAt: null,
            accountId: null,
            clientMsgId: null,
            failCode: null,
            resolvedVars: { event: "季度评审", location: "共享盘/第二季度" },
            varSources: { event: "default", location: "step:2" },
          },
          {
            index: 3,
            status: "pending",
            accountRole: "admin",
            delaySeconds: 3,
            scheduledAt: null,
            sentAt: null,
            skippedAt: null,
            accountId: null,
            clientMsgId: null,
            failCode: null,
            resolvedVars: { event: "季度评审", location: "共享盘/第二季度" },
            varSources: { event: "default", location: "step:2" },
          },
        ],
      });
    });

    it("不存在 → 404 SEQUENCE_RUN_NOT_FOUND；未登录 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sequence-runs/nope",
        headers: viewer,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: { code: "SEQUENCE_RUN_NOT_FOUND" },
      });
      const anon = await app.inject({
        method: "GET",
        url: "/api/sequence-runs/nope",
      });
      expect(anon.statusCode).toBe(401);
    });

    it("直接调 startRun（service）与端点同一条路：vars / stepVars 省略等于空", async () => {
      const { group } = await _stageGroup();
      const { id } = await _makeSequence([
        { index: 1, accountRole: "admin", text: "无占位符", delaySeconds: 0 },
      ]);
      const { runId } = await startRun(
        group.id,
        { sequenceId: id, vars: {}, stepVars: {} },
        { clock, log: silent },
      );
      const r = await run(runId);
      expect(r.steps[0]).toMatchObject({ resolvedVars: {}, varSources: {} });
    });
  });
});
