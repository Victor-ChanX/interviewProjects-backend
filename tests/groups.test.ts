// issue #11：建群 job（题目 2.3 POST /api/groups、GET /api/groups[/:id]、PATCH /api/groups/:id、GET /api/jobs/:jobId；
// A3、A2 的 NOT_MEMBER_YET 行、B2 的建群三条）。
// 真库（tests/setup.ts 的临时 schema）；网关用 src/sim/gateway 的 buildGatewayApp 起在 listen(0) 上，
// job worker 经 createGatewayClient({ baseUrl }) 走真 HTTP。时间：应用、job、网关模拟器共用一个可拨动的假 Clock
// （邀请链接的 readyAfterMs、JOIN_TIMEOUT 的 10 秒都靠 clock.advance 推，不真 sleep）；只有模拟器 join 后推
// member_joined 用 setTimeout(0) 时等几毫秒。
// worker 不起循环：直接 await runJobTick()；maxStepsPerJob = 1 时一 tick 一步，能停在任一步之后（重启恢复）。
// member_joined 不起 SSE：从 GET /_sim/state 取事件直接喂 #8 的 ingest（它写 group_members，job 靠查表推进）。
// 多连接真并行的领取用例在 tests/groups-concurrency.test.ts。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayEvent,
  GatewayResponseError,
} from "../src/services/gateway-client.js";
import {
  JOB_ERROR_CODES,
  JOIN_POLL_MS,
  STALE_CLAIM_MS,
} from "../src/services/group-job-service.js";
import { ingest } from "../src/services/inbound-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { runJobTick } from "../src/workers/job-worker.js";
import { loginAs, makeAccount } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

/** 可拨动的假时钟：应用、job、网关模拟器共用 */
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

/** 模拟器 join 后推 member_joined 走 setTimeout(0)：给它几毫秒 */
const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const silent = logger.child({}, { level: "silent" });

/** 题目 A2 的两个硬数字（测试的预言机，不从 service 导入——导入了就是拿实现验实现） */
const JOIN_TIMEOUT_MS = 10_000;
const PROMOTE_MAX_CALLS = 2;

type SimState = {
  groups: {
    groupId: string;
    members: { platformUserId: string; isAdmin: boolean }[];
    pendingJoins: string[];
  }[];
  invites: { inviteLink: string }[];
  promoteCalls: { accountId: string; status: number; code: string | null }[];
  events: { items: { eventId: number; type: string; data: Json }[] };
};

type JobBody = {
  id: string;
  status: string;
  step: string | null;
  errors: {
    step: string;
    stepKind: string;
    accountId: string | null;
    code: string;
    message: string | null;
  }[];
};

/** 题目 2.3 只要求 errors[].step / code；多下发的 stepKind / accountId / message 不参与比较 */
const briefErrors = (job: JobBody) =>
  job.errors.map((e) => ({ step: e.step, code: e.code }));

type GroupBody = {
  id: string;
  gatewayGroupId: string | null;
  status: string;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: { accountId: string | null; platformUserId: string; role: string }[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
};

describe("建群 job（#11）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
  /** 已喂给 ingest 的最大网关 eventId */
  let fedUpTo = 0;

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
    fedUpTo = 0;
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    // 202 后立刻推 member_joined（setTimeout(0)）：本文件关心的是 job 的状态机，不是网关的延时
    await scenario({ join: { delayMs: 0 } });
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

  /** 在网关 connect 一个账号并在本地建成 online（platformUserId 一致） */
  async function onlineAccount(status: "online" | "idle" = "online") {
    const id = `acc-${randomUUID().slice(0, 8)}`;
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${id}/connect`,
    });
    expect(res.statusCode).toBe(200);
    const { platformUserId } = res.json<{ platformUserId: string }>();
    return makeAccount({ id, status, platformUserId });
  }

  async function postGroup(
    creatorAccountId: string,
    memberAccountIds: string[],
    headers = admin,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/groups",
      headers,
      payload: { creatorAccountId, memberAccountIds },
    });
  }

  async function createJob(memberCount = 2) {
    const creator = await onlineAccount();
    const members: string[] = [];
    for (let i = 0; i < memberCount; i++)
      members.push((await onlineAccount()).id);
    const res = await postGroup(creator.id, members);
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    const job = await getDb().job.findUniqueOrThrow({ where: { id: jobId } });
    return { creator, members, jobId, groupId: job.groupId! };
  }

  const tick = (
    opts: {
      workerId?: string;
      maxStepsPerJob?: number;
      gateway?: GatewayClient;
    } = {},
  ) =>
    runJobTick({
      clock,
      gateway: opts.gateway ?? gatewayClient,
      workerId: opts.workerId ?? "w1",
      log: silent,
      maxStepsPerJob: opts.maxStepsPerJob,
    });

  /** 把网关新产生的事件（member_joined 等）喂给 #8 的 ingest（写 group_members） */
  async function pumpEvents(): Promise<number> {
    const s = await simState();
    let n = 0;
    for (const e of s.events.items) {
      if (e.eventId <= fedUpTo) continue;
      const event: GatewayEvent = {
        eventId: e.eventId,
        type: e.type,
        data: e.data,
      };
      await ingest(event, { clock, log: silent });
      fedUpTo = e.eventId;
      n += 1;
    }
    return n;
  }

  const readJob = (jobId: string) =>
    getDb().job.findUniqueOrThrow({ where: { id: jobId } });

  const stateOf = async (jobId: string) =>
    (await readJob(jobId)).state as {
      currentAccountId: string | null;
      invite: { link: string | null };
      joins: Record<string, { status: string; inviteRetries: number }>;
      promote: { calls: number };
    };

  /**
   * 推到终态：每轮 = 等模拟器的定时器 → 喂事件 → 拨表 advanceMs（job 的 nextRunAt 才会到点）→ tick。
   * 用轮数上限而不是真等。
   */
  async function runToEnd(
    jobId: string,
    opts: { advanceMs?: number; maxRounds?: number } = {},
  ): Promise<JobBody> {
    const advanceMs = opts.advanceMs ?? JOIN_POLL_MS;
    for (let i = 0; i < (opts.maxRounds ?? 60); i++) {
      await sleepMs(5);
      await pumpEvents();
      clock.advance(advanceMs);
      await tick();
      if ((await readJob(jobId)).status !== "running") break;
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    return res.json<JobBody>();
  }

  const getGroup = async (groupId: string, headers = admin) =>
    app.inject({ method: "GET", url: `/api/groups/${groupId}`, headers });

  const localMembers = (groupId: string) =>
    getDb().groupMember.findMany({
      where: { groupId },
      orderBy: [{ joinedAt: "asc" }, { platformUserId: "asc" }],
    });

  // ---- 主流程 ------------------------------------------------------------------------

  describe("主流程", () => {
    it("建群 → 邀请 → 两个成员 join → member_joined → promote → finished；角色 creator / admin / member", async () => {
      const { creator, members, jobId, groupId } = await createJob(2);

      // 202 时：群行已在（gatewayGroupId 空、开关默认 false、成员空），job running / step create
      const before = (await getGroup(groupId)).json<GroupBody>();
      expect(before).toMatchObject({
        id: groupId,
        gatewayGroupId: null,
        status: "active",
        creatorAccountId: creator.id,
        agentEnabled: false,
        autoKickEnabled: false,
        members: [],
        activeSequenceRunId: null,
        activeAgentRunId: null,
      });
      const jobBefore = (
        await app.inject({
          method: "GET",
          url: `/api/jobs/${jobId}`,
          headers: admin,
        })
      ).json<JobBody>();
      expect(jobBefore).toMatchObject({
        status: "running",
        step: "create",
        errors: [],
      });

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });

      const after = (await getGroup(groupId)).json<GroupBody>();
      expect(after.gatewayGroupId).toEqual(expect.any(String));
      const roles: Record<string, string> = Object.fromEntries(
        after.members.map((m): [string, string] => [m.accountId ?? "", m.role]),
      );
      expect(roles).toEqual({
        [creator.id]: "creator",
        [members[0]!]: "admin",
        [members[1]!]: "member",
      });
      for (const m of after.members) {
        const account = await getDb().account.findUniqueOrThrow({
          where: { id: m.accountId! },
        });
        expect(m.platformUserId).toBe(account.platformUserId);
      }

      // 网关侧：一个群、三个成员、memberAccountIds[0] 是 admin、promote 恰好一次
      const sim = await simState();
      expect(sim.groups).toHaveLength(1);
      expect(sim.groups[0]!.groupId).toBe(after.gatewayGroupId);
      expect(sim.groups[0]!.members).toHaveLength(3);
      const adminAccount = await getDb().account.findUniqueOrThrow({
        where: { id: members[0]! },
      });
      expect(
        sim.groups[0]!.members.find(
          (m) => m.platformUserId === adminAccount.platformUserId,
        )?.isAdmin,
      ).toBe(true);
      expect(sim.promoteCalls).toHaveLength(1);
      expect(sim.invites).toHaveLength(1);

      // job 行：终态释放领取、finishedAt 有值；ws 事件里有 job 终态与 promoted
      const row = await readJob(jobId);
      expect(row).toMatchObject({
        status: "finished",
        claimedBy: null,
        lockedAt: null,
        nextRunAt: null,
      });
      expect(row.finishedAt).not.toBeNull();
      const jobEvents = await getDb().wsEvent.findMany({
        where: { type: "job" },
        orderBy: { id: "asc" },
      });
      expect(jobEvents.at(-1)?.payload).toMatchObject({
        jobId,
        status: "finished",
      });
      const promoted = await getDb().wsEvent.findMany({
        where: {
          type: "member_changed",
          payload: { path: ["change"], equals: "promoted" },
        },
      });
      expect(promoted).toHaveLength(1);
      expect(promoted[0]!.payload).toMatchObject({
        groupId,
        accountId: members[0],
      });
    });

    it("GET /api/groups 是题目形状的裸数组；activeSequenceRunId / activeAgentRunId 只在 running 时非空", async () => {
      const { jobId, groupId } = await createJob(1);
      await runToEnd(jobId);
      const sequence = await getDb().sequence.create({
        data: { name: "s", steps: [] },
      });
      const seqRun = await getDb().sequenceRun.create({
        data: {
          sequenceId: sequence.id,
          groupId,
          status: "running",
          vars: {},
          stepVars: {},
        },
      });
      const agentRun = await getDb().agentRun.create({
        data: { groupId, status: "running", triggerMessages: [] },
      });
      // 另一个群没有运行
      const { jobId: job2, groupId: group2 } = await createJob(1);
      await runToEnd(job2);

      const list = (
        await app.inject({ method: "GET", url: "/api/groups", headers: viewer })
      ).json<GroupBody[]>();
      expect(Array.isArray(list)).toBe(true);
      expect(list.map((g) => g.id)).toEqual([groupId, group2]);
      expect(list[0]).toMatchObject({
        activeSequenceRunId: seqRun.id,
        activeAgentRunId: agentRun.id,
      });
      expect(list[1]).toMatchObject({
        activeSequenceRunId: null,
        activeAgentRunId: null,
      });
      expect(list[0]!.members).toHaveLength(2);

      await getDb().agentRun.update({
        where: { id: agentRun.id },
        data: { status: "finished" },
      });
      const one = (await getGroup(groupId)).json<GroupBody>();
      expect(one).toMatchObject({
        activeSequenceRunId: seqRun.id,
        activeAgentRunId: null,
      });
    });
  });

  // ---- 邀请链接（B2）--------------------------------------------------------------------

  describe("邀请链接", () => {
    it("readyAfterMs > 0：先按 readyAt 排期不白打；仍 INVITE_NOT_READY 时按 readyAfterMs 排 nextRunAt，等到后成功", async () => {
      await scenario({ invite: { readyAfterMs: 3_000 } });
      const { jobId } = await createJob(1);
      await tick();
      // create + invite 已做，join 排在 readyAt，还没调 join
      const t0 = clock.now().getTime();
      let row = await readJob(jobId);
      expect(row.step).toBe("join");
      expect(row.claimedBy).toBeNull();
      expect(row.nextRunAt!.getTime()).toBe(t0 + 3_000);
      expect((await simState()).groups[0]!.pendingJoins).toEqual([]);
      const s1 = await stateOf(jobId);
      expect(s1.joins[Object.keys(s1.joins)[0]!]!.status).toBe("pending");

      // 没到点：tick 领不到
      const idle = await tick();
      expect(idle.claimed).toBe(0);

      // 模拟时钟偏差：把排期抹掉让它提前去 join → 网关 409 INVITE_NOT_READY → 重新按 readyAt 排期，不算失败
      await getDb().job.update({
        where: { id: jobId },
        data: { nextRunAt: null },
      });
      clock.advance(1_000);
      const early = await tick();
      expect(early.claimed).toBe(1);
      row = await readJob(jobId);
      expect(row.status).toBe("running");
      expect(row.nextRunAt!.getTime()).toBe(t0 + 3_000);
      expect((await simState()).groups[0]!.pendingJoins).toEqual([]);
      expect(await getDb().jobError.count()).toBe(0);

      clock.advance(2_000);
      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect((await simState()).invites).toHaveLength(1);
    });

    it("INVITE_EXPIRED：重新申请一次链接后成功；第二次再过期记 errors、job failed", async () => {
      // 一 tick 一步：create → invite → join
      const { jobId, members } = await createJob(1);
      await tick({ maxStepsPerJob: 1 });
      await tick({ maxStepsPerJob: 1 });
      expect((await readJob(jobId)).step).toBe("join");
      await gateway.inject({ method: "POST", url: "/_sim/invites/expire" });

      await tick({ maxStepsPerJob: 1 });
      const s = await stateOf(jobId);
      expect((await readJob(jobId)).step).toBe("invite");
      expect(s.invite).toMatchObject({ link: null });
      expect(s.joins[members[0]!]!.inviteRetries).toBe(1);
      expect(await getDb().jobError.count()).toBe(0);

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect((await simState()).invites).toHaveLength(2);

      // 第二个 job：两条链接都过期 → join:<accountId> INVITE_EXPIRED
      const second = await createJob(1);
      await tick({ maxStepsPerJob: 1 });
      await tick({ maxStepsPerJob: 1 });
      await gateway.inject({ method: "POST", url: "/_sim/invites/expire" });
      await tick({ maxStepsPerJob: 1 }); // INVITE_EXPIRED → 回 invite
      await tick({ maxStepsPerJob: 1 }); // 重新申请 → join
      await gateway.inject({ method: "POST", url: "/_sim/invites/expire" });
      const failed = await runToEnd(second.jobId);
      expect(failed.status).toBe("failed");
      expect(briefErrors(failed)).toEqual([
        { step: `join:${second.members[0]}`, code: "INVITE_EXPIRED" },
      ]);
      expect((await simState()).promoteCalls).toHaveLength(1); // 第一个 job 的
      expect(members).toHaveLength(1);
    });
  });

  it("INVITE_EXPIRED 的重试是每个成员各一次：m1、m2 各遇到一次过期，都重新申请后入群", async () => {
    const { members, jobId } = await createJob(2);
    await tick({ maxStepsPerJob: 1 }); // create
    await tick({ maxStepsPerJob: 1 }); // invite → join
    await gateway.inject({ method: "POST", url: "/_sim/invites/expire" });
    await tick({ maxStepsPerJob: 1 }); // m1 INVITE_EXPIRED → 回 invite
    await tick({ maxStepsPerJob: 1 }); // 重新申请 → join
    // m1 用新链接入群，走到 m2 时链接又过期：m2 自己还有一次重试机会
    for (let i = 0; i < 20; i++) {
      await sleepMs(5);
      await pumpEvents();
      clock.advance(JOIN_POLL_MS);
      await tick({ maxStepsPerJob: 1 });
      if ((await stateOf(jobId)).currentAccountId === members[1]) break;
    }
    await gateway.inject({ method: "POST", url: "/_sim/invites/expire" });
    const job = await runToEnd(jobId);
    expect(job).toMatchObject({ status: "finished", errors: [] });
    const s = await stateOf(jobId);
    expect(members.map((m) => s.joins[m]!.inviteRetries)).toEqual([1, 1]);
    expect((await simState()).invites).toHaveLength(3);
  });

  it("入群时网关以 ACCOUNT_SUSPENDED 拒绝：该账号进 suspended（A2 错误表对所有请求适用），这一步记 errors", async () => {
    const { members, jobId } = await createJob(1);
    const suspendedJoin: GatewayClient = {
      ...gatewayClient,
      async joinGroup() {
        throw new GatewayResponseError("POST", "/join", 403, {
          code: "ACCOUNT_SUSPENDED",
        });
      },
    };
    for (let i = 0; i < 5; i++) await tick({ gateway: suspendedJoin });
    expect(
      (await getDb().account.findUniqueOrThrow({ where: { id: members[0]! } }))
        .status,
    ).toBe("suspended");
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: admin,
    });
    expect(briefErrors(res.json<JobBody>())).toEqual([
      { step: `join:${members[0]}`, code: "ACCOUNT_SUSPENDED" },
    ]);
  });

  // ---- join 等待 ------------------------------------------------------------------------

  describe("join 与 member_joined", () => {
    it("ALREADY_MEMBER 视为已入群：成员行由 job 自己写、照常 promote、finished", async () => {
      const { members, jobId, groupId } = await createJob(2);
      await tick({ maxStepsPerJob: 2 }); // create + invite
      // 网关侧：memberAccountIds[0] 已经在群里（外部途径），本地不喂这条 member_joined
      const first = await getDb().account.findUniqueOrThrow({
        where: { id: members[0]! },
      });
      const sim0 = await simState();
      await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "member_joined",
          groupId: sim0.groups[0]!.groupId,
          platformUserId: first.platformUserId,
        },
      });
      fedUpTo = (await simState()).events.items.at(-1)!.eventId;

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const rows = await localMembers(groupId);
      const admin0 = rows.find((r) => r.accountId === members[0]);
      expect(admin0).toMatchObject({
        role: "admin",
        platformUserId: first.platformUserId,
      });
      expect(rows.find((r) => r.accountId === members[1])?.role).toBe("member");
      const sim = await simState();
      expect(sim.promoteCalls.map((c) => c.status)).toEqual([200]);
      expect(sim.groups[0]!.members).toHaveLength(3);
    });

    it("member_joined 10 秒未到 → join:<accountId> JOIN_TIMEOUT、job failed，其余成员继续、不 promote", async () => {
      await scenario({ join: { neverJoin: true } });
      const { creator, members, jobId, groupId } = await createJob(2);
      await tick(); // create + invite + join(m1) 受理 → 等
      const s = await stateOf(jobId);
      expect(s.joins[members[0]!]!.status).toBe("accepted");
      expect(s.currentAccountId).toBe(members[0]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/jobs/${jobId}`,
            headers: viewer,
          })
        ).json<JobBody>().step,
      ).toBe(`join:${members[0]}`);

      // 9.9 秒内不算超时
      clock.advance(JOIN_TIMEOUT_MS - 100);
      await tick();
      expect((await readJob(jobId)).status).toBe("running");
      expect(await getDb().jobError.count()).toBe(0);

      // 超过 10 秒：m1 超时，继续 m2，m2 也超时；两条 errors，job failed，promote 一次都没调
      const job = await runToEnd(jobId, { advanceMs: JOIN_TIMEOUT_MS + 1 });
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: `join:${members[0]}`, code: JOB_ERROR_CODES.joinTimeout },
        { step: `join:${members[1]}`, code: JOB_ERROR_CODES.joinTimeout },
      ]);
      expect((await simState()).promoteCalls).toHaveLength(0);
      const rows = await localMembers(groupId);
      expect(rows.map((r) => [r.accountId, r.role])).toEqual([
        [creator.id, "creator"],
      ]);
      // 群本身还在、状态不变（B2：群和账号状态都不变）
      expect((await getGroup(groupId)).json<GroupBody>().status).toBe("active");
    });

    it("入站积压（停机刚恢复）：member_joined 已推但还没处理，超过 10 秒时先问网关 —— 已在群里就不记 JOIN_TIMEOUT", async () => {
      await scenario({ join: { delayMs: { min: 0, max: 0 } } });
      const { members, jobId, groupId } = await createJob(1);
      await tick(); // create + invite + join 受理 → 等
      await sleepMs(20); // 模拟器把账号加进群、推 member_joined —— 但这里不喂给入站（积压）
      expect(await localMembers(groupId)).toHaveLength(1);
      clock.advance(JOIN_TIMEOUT_MS + 1);
      await tick();
      const s = await stateOf(jobId);
      expect(s.joins[members[0]!]!.status).toBe("joined");
      expect(await getDb().jobError.count()).toBe(0);
      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      // 晚到的 member_joined 补处理：不多一行，角色仍是 promote 后的 admin
      await pumpEvents();
      const rows = await localMembers(groupId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.accountId === members[0])?.role).toBe("admin");
    });

    it("job 还在处理其余成员时，errors 一旦非空 GET /api/jobs 就报 failed（题目：errors 非空即 failed）", async () => {
      await scenario({ join: { neverJoin: true } });
      const { jobId } = await createJob(2);
      await tick();
      clock.advance(JOIN_TIMEOUT_MS + 1);
      await tick(); // m1 超时记 errors，转 m2 继续
      expect((await readJob(jobId)).status).toBe("running");
      const res = await app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
        headers: viewer,
      });
      expect(res.json<JobBody>().status).toBe("failed");
      expect(res.json<JobBody>().errors).toHaveLength(1);
    });

    it("一个成员超时不影响其余成员：m1 入群并被 promote，m2 超时 → failed 但 m1 是 admin", async () => {
      await scenario({ join: { neverJoin: true } });
      const { members, jobId, groupId } = await createJob(2);
      await tick(); // m1 受理
      const first = await getDb().account.findUniqueOrThrow({
        where: { id: members[0]! },
      });
      await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "member_joined",
          groupId: (await simState()).groups[0]!.groupId,
          platformUserId: first.platformUserId,
        },
      });
      const job = await runToEnd(jobId, { advanceMs: JOIN_TIMEOUT_MS + 1 });
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: `join:${members[1]}`, code: JOB_ERROR_CODES.joinTimeout },
      ]);
      expect(
        (await localMembers(groupId)).find((r) => r.accountId === members[0])
          ?.role,
      ).toBe("admin");
      expect((await simState()).promoteCalls.map((c) => c.status)).toEqual([
        200,
      ]);
    });
  });

  // ---- promote（A2 的 NOT_MEMBER_YET 行）--------------------------------------------------

  describe("promote", () => {
    /** 让本地成员表「先于」网关认为 m1 已入群：job 会去 promote，网关回 NOT_MEMBER_YET */
    async function stageNotMemberYet() {
      await scenario({ join: { neverJoin: true } });
      const created = await createJob(1);
      await tick(); // m1 受理，等 member_joined
      const first = await getDb().account.findUniqueOrThrow({
        where: { id: created.members[0]! },
      });
      await getDb().groupMember.create({
        data: {
          groupId: created.groupId,
          platformUserId: first.platformUserId!,
          accountId: first.id,
          role: "member",
        },
      });
      clock.advance(JOIN_POLL_MS);
      await tick(); // 查表见到 → promote → NOT_MEMBER_YET → 排期再试
      const s = await stateOf(created.jobId);
      expect(s.promote.calls).toBe(1);
      expect((await readJob(created.jobId)).status).toBe("running");
      expect((await simState()).promoteCalls.map((c) => c.code)).toEqual([
        "NOT_MEMBER_YET",
      ]);
      return { ...created, platformUserId: first.platformUserId! };
    }

    it("NOT_MEMBER_YET 后再试一次成功：调用总数 = 2，成员 role = admin", async () => {
      const { jobId, groupId, members, platformUserId } =
        await stageNotMemberYet();
      // 网关侧这时才真正入群
      await gateway.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "member_joined",
          groupId: (await simState()).groups[0]!.groupId,
          platformUserId,
        },
      });
      const job = await runToEnd(jobId, { advanceMs: 500 });
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const sim = await simState();
      expect(sim.promoteCalls.map((c) => c.code)).toEqual([
        "NOT_MEMBER_YET",
        null,
      ]);
      expect(sim.promoteCalls.length).toBeLessThanOrEqual(PROMOTE_MAX_CALLS);
      expect(
        (await localMembers(groupId)).find((r) => r.accountId === members[0])
          ?.role,
      ).toBe("admin");
    });

    it("两次都 NOT_MEMBER_YET：不再调第三次，errors = [{ promote, NOT_MEMBER_YET }]，job failed", async () => {
      const { jobId, groupId, members } = await stageNotMemberYet();
      const job = await runToEnd(jobId, { advanceMs: 500 });
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: "promote", code: "NOT_MEMBER_YET" },
      ]);
      expect((await simState()).promoteCalls).toHaveLength(PROMOTE_MAX_CALLS);
      expect(
        (await localMembers(groupId)).find((r) => r.accountId === members[0])
          ?.role,
      ).toBe("member");
    });

    it("NO_PERMISSION（群主已不是群主）记 errors、job failed，成员 role 不变", async () => {
      const { creator, jobId, groupId, members } = await createJob(1);
      await tick(); // 到等待 member_joined
      await sleepMs(5);
      await pumpEvents();
      // 群主在网关侧退群 → promote 得到 403 NO_PERMISSION
      const sim0 = await simState();
      await gateway.inject({
        method: "POST",
        url: `/groups/${sim0.groups[0]!.groupId}/leave`,
        payload: { accountId: creator.id },
      });
      const job = await runToEnd(jobId);
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: "promote", code: "NO_PERMISSION" },
      ]);
      expect((await simState()).promoteCalls).toHaveLength(1);
      expect(
        (await localMembers(groupId)).find((r) => r.accountId === members[0])
          ?.role,
      ).toBe("member");
    });
  });

  // ---- 校验与闸门 ------------------------------------------------------------------------

  describe("POST /api/groups 校验", () => {
    it("memberAccountIds 为空 / 含群主 / 重复 / 缺字段 → 400 VALIDATION_ERROR", async () => {
      const creator = await onlineAccount();
      const member = await onlineAccount();
      for (const payload of [
        { creatorAccountId: creator.id, memberAccountIds: [] },
        {
          creatorAccountId: creator.id,
          memberAccountIds: [member.id, creator.id],
        },
        {
          creatorAccountId: creator.id,
          memberAccountIds: [member.id, member.id],
        },
        { memberAccountIds: [member.id] },
        { creatorAccountId: creator.id },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/groups",
          headers: admin,
          payload,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json<{ error: { code: string } }>().error.code).toBe(
          "VALIDATION_ERROR",
        );
      }
      expect(await getDb().job.count()).toBe(0);
      expect(await getDb().group.count()).toBe(0);
    });

    it("账号不 online（idle / 不存在，含群主）→ 422 ACCOUNT_NOT_ONLINE，extra.accountIds 列出不合格的；不落任何行", async () => {
      const creator = await onlineAccount();
      const online = await onlineAccount();
      const idle = await onlineAccount("idle");
      const res = await postGroup(creator.id, [
        online.id,
        idle.id,
        "acc-missing",
      ]);
      expect(res.statusCode).toBe(422);
      const body = res.json<{
        error: { code: string; accountIds: string[] };
      }>();
      expect(body.error.code).toBe("ACCOUNT_NOT_ONLINE");
      expect(body.error.accountIds).toEqual([idle.id, "acc-missing"]);

      const res2 = await postGroup(idle.id, [online.id]);
      expect(res2.statusCode).toBe(422);
      expect(
        res2.json<{ error: { accountIds: string[] } }>().error.accountIds,
      ).toEqual([idle.id]);
      expect(await getDb().job.count()).toBe(0);
      expect(await getDb().group.count()).toBe(0);
    });

    it("viewer 建群 / 改开关 → 403 FORBIDDEN；viewer 可读；未登录 401", async () => {
      const creator = await onlineAccount();
      const member = await onlineAccount();
      const denied = await postGroup(creator.id, [member.id], viewer);
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe(
        "FORBIDDEN",
      );
      expect(await getDb().job.count()).toBe(0);

      const { groupId, jobId } = await createJob(1);
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: viewer,
        payload: { agentEnabled: true },
      });
      expect(patch.statusCode).toBe(403);
      expect((await getGroup(groupId, viewer)).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/jobs/${jobId}`,
            headers: viewer,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/api/groups" })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: "GET", url: `/api/jobs/${jobId}` }))
          .statusCode,
      ).toBe(401);
    });

    it("群 / job 不存在 → 404 GROUP_NOT_FOUND / JOB_NOT_FOUND", async () => {
      const g = await getGroup("no-such-group");
      expect(g.statusCode).toBe(404);
      expect(g.json<{ error: { code: string } }>().error.code).toBe(
        "GROUP_NOT_FOUND",
      );
      const p = await app.inject({
        method: "PATCH",
        url: "/api/groups/no-such-group",
        headers: admin,
        payload: { agentEnabled: true },
      });
      expect(p.statusCode).toBe(404);
      const j = await app.inject({
        method: "GET",
        url: "/api/jobs/no-such-job",
        headers: admin,
      });
      expect(j.statusCode).toBe(404);
      expect(j.json<{ error: { code: string } }>().error.code).toBe(
        "JOB_NOT_FOUND",
      );
    });
  });

  describe("PATCH /api/groups/:id", () => {
    it("只改传了的开关；有变化写 ws_events group_settings_changed，没变化不写；返回题目形状", async () => {
      const { groupId } = await createJob(1);
      const on = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: admin,
        payload: { agentEnabled: true },
      });
      expect(on.statusCode).toBe(200);
      expect(on.json<GroupBody>()).toMatchObject({
        id: groupId,
        agentEnabled: true,
        autoKickEnabled: false,
      });

      const both = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: admin,
        payload: { autoKickEnabled: true },
      });
      expect(both.json<GroupBody>()).toMatchObject({
        agentEnabled: true,
        autoKickEnabled: true,
      });

      // 同值 / 空体：不写事件
      await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: admin,
        payload: { agentEnabled: true },
      });
      await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: admin,
        payload: {},
      });
      const events = await getDb().wsEvent.findMany({
        where: { type: "group_settings_changed" },
        orderBy: { id: "asc" },
      });
      expect(events.map((e) => e.payload)).toEqual([
        { groupId, agentEnabled: true, autoKickEnabled: false },
        { groupId, agentEnabled: true, autoKickEnabled: true },
      ]);
      const row = await getDb().group.findUniqueOrThrow({
        where: { id: groupId },
      });
      expect(row).toMatchObject({ agentEnabled: true, autoKickEnabled: true });

      const bad = await app.inject({
        method: "PATCH",
        url: `/api/groups/${groupId}`,
        headers: admin,
        payload: { agentEnabled: "yes" },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  // ---- 重启恢复（background-workers：任一步之后死掉，接手者从该步继续，外部效果不重复）----------

  describe("重启恢复", () => {
    /** 模拟领取者死在步骤中途：claimedBy 还挂着、lockedAt 已过旧 */
    async function killWorker(jobId: string) {
      await getDb().job.update({
        where: { id: jobId },
        data: {
          claimedBy: "dead-worker",
          lockedAt: new Date(clock.now().getTime() - STALE_CLAIM_MS - 1),
        },
      });
    }

    it("invite 之后死掉：新实例回收领取、从 join 继续；网关只建了一个群、一条链接", async () => {
      const { jobId, groupId } = await createJob(2);
      await tick({ maxStepsPerJob: 2 }); // create + invite
      expect((await readJob(jobId)).step).toBe("join");
      expect(
        (await getGroup(groupId)).json<GroupBody>().members.map((m) => m.role),
      ).toEqual(["creator"]);
      await killWorker(jobId);

      // 新实例：回收过旧的领取并接手（从 join 继续，不重做 create / invite）
      const resumed = await runJobTick({
        clock,
        gateway: gatewayClient,
        workerId: "w2",
        log: silent,
      });
      expect(resumed).toMatchObject({ recovered: 1, claimed: 1 });
      expect((await readJob(jobId)).step).toBe("join");

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const sim = await simState();
      expect(sim.groups).toHaveLength(1);
      expect(sim.invites).toHaveLength(1);
      expect(sim.groups[0]!.members).toHaveLength(3);
      expect(sim.promoteCalls).toHaveLength(1);
      expect(
        (await getGroup(groupId))
          .json<GroupBody>()
          .members.map((m) => m.role)
          .sort(),
      ).toEqual(["admin", "creator", "member"]);
    });

    it("join 受理后、member_joined 到达前死掉：新实例从等待继续，不再 join 第二次，最终 finished", async () => {
      await scenario({ join: { delayMs: 0 } });
      const { members, jobId, groupId } = await createJob(2);
      await tick(); // create + invite + join(m1) 受理 → 等待
      expect((await stateOf(jobId)).joins[members[0]!]!.status).toBe(
        "accepted",
      );
      await killWorker(jobId);

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const sim = await simState();
      // 每个成员恰好一次 member_joined（join 没有被重发成第二次受理）
      const joinedEvents = sim.events.items.filter(
        (e) => e.type === "member_joined",
      );
      expect(joinedEvents).toHaveLength(2);
      expect(sim.groups[0]!.members).toHaveLength(3);
      expect(sim.promoteCalls).toHaveLength(1);
      expect(await localMembers(groupId)).toHaveLength(3);
    });

    it("lockedAt 未过旧的领取不回收（同一 job 不会被两个副本同时推进）", async () => {
      const { jobId } = await createJob(1);
      await getDb().job.update({
        where: { id: jobId },
        data: { claimedBy: "alive-worker", lockedAt: clock.now() },
      });
      const stats = await tick({ workerId: "w2" });
      expect(stats).toMatchObject({ recovered: 0, claimed: 0 });
      expect((await readJob(jobId)).claimedBy).toBe("alive-worker");
    });
  });
});
