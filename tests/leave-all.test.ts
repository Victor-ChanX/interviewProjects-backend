// issue #16：leave-all job（题目 2.3 POST /api/groups/:id/leave-all、GET /api/jobs/:jobId 的 leave:<accountId> 步、
// 群 status left；B2「非群主先退、群主最后退，失败记 errors 其余继续、群主不退、失败账号在库与网关里仍是成员，
// 完成后成员表与网关一致」）。
// 搭法与 tests/groups.test.ts 相同：真库 + src/sim/gateway 起在 listen(0) 上 + 直接 await runJobTick（不起循环，
// maxStepsPerJob = 1 能停在任一步之后）+ 从 GET /_sim/state 取事件喂 ingest（member_left 删成员行）+ 共用假 Clock。
// 每个用例先用 #11 的建群 job 造一个「群主 + 两个成员」的真群（网关里也有），再对它 leave-all。
// 并发两次 leave-all 恰好一个成功（部分唯一索引）在 tests/groups-concurrency.test.ts。
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
  JOIN_POLL_MS,
  STALE_CLAIM_MS,
} from "../src/services/group-job-service.js";
import { ingest } from "../src/services/inbound-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { runJobTick } from "../src/workers/job-worker.js";
import { loginAs, makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

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

/** 模拟器 leave / join 后推事件走 setTimeout(0)：给它几毫秒 */
const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const silent = logger.child({}, { level: "silent" });

type SimState = {
  groups: {
    groupId: string;
    ownerLeft: boolean;
    members: { platformUserId: string; isAdmin: boolean }[];
  }[];
  leaveCalls: {
    groupId: string;
    accountId: string;
    status: number;
    code: string | null;
  }[];
  events: { items: { eventId: number; type: string; data: Json }[] };
};

type JobBody = {
  id: string;
  kind: string;
  status: string;
  groupId: string | null;
  step: string | null;
  errors: {
    step: string;
    stepKind: string;
    accountId: string | null;
    code: string;
    message: string | null;
  }[];
  createdAt: string;
  finishedAt: string | null;
};

const briefErrors = (job: JobBody) =>
  job.errors.map((e) => ({ step: e.step, code: e.code }));

type GroupBody = {
  id: string;
  gatewayGroupId: string | null;
  status: string;
  members: { accountId: string | null; platformUserId: string; role: string }[];
};

type ErrorBody = { error: { code: string; requestId: string } };

type LeaveAllState = {
  currentAccountId: string | null;
  leaves: Record<string, string>;
  transientFailures: number;
};

describe("leave-all job（#16）", () => {
  const clock = fakeClock();
  let app: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
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
    // 202 后立刻推 member_joined、kick 立刻响应：本文件关心的是 leave-all 的状态机，不是网关的延时
    await scenario({ join: { delayMs: 0 }, kick: { responseDelayMs: 0 } });
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

  async function onlineAccount() {
    const id = `acc-${randomUUID().slice(0, 8)}`;
    const res = await gateway.inject({
      method: "POST",
      url: `/accounts/${id}/connect`,
    });
    expect(res.statusCode).toBe(200);
    const { platformUserId } = res.json<{ platformUserId: string }>();
    return makeAccount({ id, status: "online", platformUserId });
  }

  const tick = (opts: { workerId?: string; maxStepsPerJob?: number } = {}) =>
    runJobTick({
      clock,
      gateway: gatewayClient,
      workerId: opts.workerId ?? "w1",
      log: silent,
      maxStepsPerJob: opts.maxStepsPerJob,
    });

  /** 网关新产生的事件（member_joined / member_left）喂给 #8 的 ingest */
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
    (await readJob(jobId)).state as LeaveAllState;

  const getJobApi = async (jobId: string, headers = admin) =>
    app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers });

  /** 推到终态：每轮 = 等模拟器定时器 → 喂事件 → 拨表 → tick；用轮数上限而不是真等 */
  async function runToEnd(
    jobId: string,
    opts: { pump?: boolean; maxRounds?: number } = {},
  ): Promise<JobBody> {
    for (let i = 0; i < (opts.maxRounds ?? 60); i++) {
      await sleepMs(5);
      if (opts.pump !== false) await pumpEvents();
      clock.advance(JOIN_POLL_MS);
      await tick();
      if ((await readJob(jobId)).status !== "running") break;
    }
    const res = await getJobApi(jobId);
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

  /** 用 #11 的建群 job 造一个真群：群主 + n 个成员，网关里也有；返回各账号与 gatewayGroupId */
  async function readyGroup(memberCount = 2) {
    const creator = await onlineAccount();
    const members = [];
    for (let i = 0; i < memberCount; i++) members.push(await onlineAccount());
    const res = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: admin,
      payload: {
        creatorAccountId: creator.id,
        memberAccountIds: members.map((m) => m.id),
      },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    const created = await runToEnd(jobId);
    expect(created).toMatchObject({ status: "finished", errors: [] });
    const groupId = (await readJob(jobId)).groupId!;
    const group = (await getGroup(groupId)).json<GroupBody>();
    expect(group.members).toHaveLength(memberCount + 1);
    return {
      creator,
      members,
      groupId,
      gatewayGroupId: group.gatewayGroupId!,
    };
  }

  const postLeaveAll = (groupId: string, headers = admin) =>
    app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/leave-all`,
      headers,
    });

  async function startLeaveAll(groupId: string): Promise<string> {
    const res = await postLeaveAll(groupId);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ jobId: string }>();
    expect(Object.keys(body)).toEqual(["jobId"]);
    return body.jobId;
  }

  const simGroup = async (gatewayGroupId: string) =>
    (await simState()).groups.find((g) => g.groupId === gatewayGroupId)!;

  // ---- 主流程 ------------------------------------------------------------------------

  describe("主流程", () => {
    it("两个成员 + 群主：非群主按顺序先退、群主最后退；群 left、members = []；job finished；成员表与网关一致", async () => {
      const { creator, members, groupId, gatewayGroupId } = await readyGroup(2);
      const [m1, m2] = members as [typeof creator, typeof creator];

      const jobId = await startLeaveAll(groupId);
      // 202 时：job running / step leave（还没轮到谁）、群仍 active、成员未动、网关一次 leave 都没收到
      const accepted = (await getJobApi(jobId)).json<JobBody>();
      expect(accepted).toMatchObject({
        id: jobId,
        kind: "leave_all",
        status: "running",
        groupId,
        step: "leave",
        errors: [],
        finishedAt: null,
      });
      expect(accepted.createdAt).toEqual(expect.any(String));
      expect((await getGroup(groupId)).json<GroupBody>().status).toBe("active");
      expect((await simState()).leaveCalls).toEqual([]);
      const state0 = await stateOf(jobId);
      expect(Object.keys(state0.leaves).sort()).toEqual(
        [m1.id, m2.id, creator.id].sort(),
      );

      // 一步一停：第一步退 m1，API 的 step 是 leave:<m1>；m1 的成员行还在（等 member_left）
      await tick({ maxStepsPerJob: 1 });
      expect((await getJobApi(jobId)).json<JobBody>().step).toBe(
        `leave:${m1.id}`,
      );
      expect((await stateOf(jobId)).leaves[m1.id]).toBe("left");
      expect((await simState()).leaveCalls.map((c) => c.accountId)).toEqual([
        m1.id,
      ]);
      expect((await localMembers(groupId)).map((m) => m.accountId)).toContain(
        m1.id,
      );

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect(job.finishedAt).toEqual(expect.any(String));

      // 网关：调用顺序 = 非群主（按入群顺序）→ 群主，都是 200；群里没人了、群主已退
      const sim = await simState();
      expect(sim.leaveCalls).toEqual([
        { groupId: gatewayGroupId, accountId: m1.id, status: 200, code: null },
        { groupId: gatewayGroupId, accountId: m2.id, status: 200, code: null },
        {
          groupId: gatewayGroupId,
          accountId: creator.id,
          status: 200,
          code: null,
        },
      ]);
      const sg = await simGroup(gatewayGroupId);
      expect(sg.members).toEqual([]);
      expect(sg.ownerLeft).toBe(true);

      // 本地：群 left、members = []；job 行释放领取；ws：group_status_changed active → left、job finished
      const group = (await getGroup(groupId)).json<GroupBody>();
      expect(group).toMatchObject({ status: "left", members: [] });
      expect(await localMembers(groupId)).toEqual([]);
      const row = await readJob(jobId);
      expect(row).toMatchObject({
        status: "finished",
        claimedBy: null,
        lockedAt: null,
        nextRunAt: null,
      });
      const statusEvents = await getDb().wsEvent.findMany({
        where: { type: "group_status_changed" },
      });
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0]!.payload).toMatchObject({
        groupId,
        from: "active",
        to: "left",
        reason: "leave_all",
      });
      const jobEvents = await getDb().wsEvent.findMany({
        where: { type: "job", payload: { path: ["jobId"], equals: jobId } },
        orderBy: { seq: "asc" },
      });
      expect(jobEvents.map((e) => (e.payload as Json).step)).toEqual([
        "leave",
        `leave:${m1.id}`,
        `leave:${m2.id}`,
        `leave:${creator.id}`,
        "leave",
      ]);
      expect(jobEvents.at(-1)?.payload).toMatchObject({ status: "finished" });
      // 对账一致：没有不一致记录
      expect(await getDb().inconsistency.count()).toBe(0);

      // 晚到的 member_left 再喂一遍：删 0 行、不报错、成员仍为空
      expect(await pumpEvents()).toBeGreaterThanOrEqual(0);
      expect(await localMembers(groupId)).toEqual([]);
    });

    it("member_left 事件一直没到：job 完成时自己清成员表（与网关最终一致），之后事件到了也幂等", async () => {
      const { groupId, gatewayGroupId } = await readyGroup(2);
      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId, { pump: false });
      expect(job.status).toBe("finished");
      expect(await localMembers(groupId)).toEqual([]);
      expect((await simGroup(gatewayGroupId)).members).toEqual([]);
      expect(await getDb().inconsistency.count()).toBe(0);
      await pumpEvents();
      expect(await localMembers(groupId)).toEqual([]);
    });

    it("unreachable 的群也能 leave-all：完成后 left，事件 from = unreachable", async () => {
      const { groupId } = await readyGroup(1);
      await getDb().group.update({
        where: { id: groupId },
        data: { status: "unreachable" },
      });
      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect((await getGroup(groupId)).json<GroupBody>().status).toBe("left");
      const ev = await getDb().wsEvent.findFirst({
        where: { type: "group_status_changed" },
      });
      expect(ev?.payload).toMatchObject({ from: "unreachable", to: "left" });
    });

    it("只有群主的群：直接群主退，left", async () => {
      const { creator, members, groupId, gatewayGroupId } = await readyGroup(1);
      // 先把唯一成员在网关里踢掉并喂 member_left，剩下群主一个人
      await gatewayClient.kick(gatewayGroupId, {
        byAccountId: creator.id,
        targetPlatformUserId: members[0]!.platformUserId!,
      });
      await sleepMs(5);
      await pumpEvents();
      expect((await localMembers(groupId)).map((m) => m.role)).toEqual([
        "creator",
      ]);

      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect((await simState()).leaveCalls.map((c) => c.accountId)).toEqual([
        creator.id,
      ]);
      expect((await getGroup(groupId)).json<GroupBody>()).toMatchObject({
        status: "left",
        members: [],
      });
    });
  });

  // ---- 失败：其余继续、群主不退、job failed（B2）------------------------------------------

  describe("非群主退群失败", () => {
    it("m1 leave 500 → m2 照常退、群主不退、job failed、errors = [{ leave:<m1>, INTERNAL }]；m1 在库与网关里仍是成员", async () => {
      const { creator, members, groupId, gatewayGroupId } = await readyGroup(2);
      const [m1, m2] = members as [typeof creator, typeof creator];
      await scenario({ leave: { failAccountIds: [m1.id] } });

      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId);
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: `leave:${m1.id}`, code: "INTERNAL" },
      ]);
      expect(job.errors[0]).toMatchObject({
        stepKind: "leave",
        accountId: m1.id,
      });

      // 网关：m1 500、m2 200、群主**没有**被调用；群主仍在、m1 仍在、m2 不在
      const sim = await simState();
      expect(
        sim.leaveCalls.map((c) => [c.accountId, c.status] as const),
      ).toEqual([
        [m1.id, 500],
        [m2.id, 200],
      ]);
      const sg = await simGroup(gatewayGroupId);
      expect(sg.ownerLeft).toBe(false);
      expect(sg.members.map((m) => m.platformUserId).sort()).toEqual(
        [creator.platformUserId, m1.platformUserId].sort(),
      );

      // 本地：群不是 left、m1 与群主仍是成员、m2 的行已清（与网关一致）；没有不一致记录
      const group = (await getGroup(groupId)).json<GroupBody>();
      expect(group.status).toBe("active");
      expect(group.members.map((m) => m.accountId).sort()).toEqual(
        [creator.id, m1.id].sort(),
      );
      expect(await getDb().inconsistency.count()).toBe(0);
      expect(
        await getDb().wsEvent.count({
          where: { type: "group_status_changed" },
        }),
      ).toBe(0);
      expect((await stateOf(jobId)).leaves).toEqual({
        [m1.id]: "failed",
        [m2.id]: "left",
        [creator.id]: "pending",
      });
      expect((await getJobApi(jobId)).json<JobBody>().step).toBe("leave");
    });

    it("账号离线 → 409 ACCOUNT_OFFLINE 记 errors、其余继续、群主不退", async () => {
      const { creator, members, groupId } = await readyGroup(2);
      const [m1, m2] = members as [typeof creator, typeof creator];
      await gateway.inject({
        method: "POST",
        url: `/accounts/${m1.id}/disconnect`,
      });

      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId);
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: `leave:${m1.id}`, code: "ACCOUNT_OFFLINE" },
      ]);
      const sim = await simState();
      expect(sim.leaveCalls.map((c) => c.accountId)).toEqual([m1.id, m2.id]);
      expect(
        (await getGroup(groupId))
          .json<GroupBody>()
          .members.map((m) => m.accountId)
          .sort(),
      ).toEqual([creator.id, m1.id].sort());
    });

    it("群主自己 leave 500：非群主都已退、群主记 errors、job failed、群不 left", async () => {
      const { creator, members, groupId, gatewayGroupId } = await readyGroup(1);
      await scenario({ leave: { failAccountIds: [creator.id] } });
      const jobId = await startLeaveAll(groupId);
      const job = await runToEnd(jobId);
      expect(job.status).toBe("failed");
      expect(briefErrors(job)).toEqual([
        { step: `leave:${creator.id}`, code: "INTERNAL" },
      ]);
      expect((await simState()).leaveCalls.map((c) => c.accountId)).toEqual([
        members[0]!.id,
        creator.id,
      ]);
      expect((await simGroup(gatewayGroupId)).ownerLeft).toBe(false);
      const group = (await getGroup(groupId)).json<GroupBody>();
      expect(group.status).toBe("active");
      expect(group.members.map((m) => m.accountId)).toEqual([creator.id]);
    });
  });

  // ---- 网关不可用：结果未知，对账后再试，不重复 leave ------------------------------------------

  describe("网关不可用", () => {
    it("503 → 退避排期（calling 留着）；恢复后先看成员列表：还在才重发；最终 finished、每个账号恰好一次 200", async () => {
      const { members, groupId } = await readyGroup(1);
      const jobId = await startLeaveAll(groupId);
      await scenario({ outage: { all: true } });
      await tick();
      const s1 = await stateOf(jobId);
      expect(s1.leaves[members[0]!.id]).toBe("calling");
      expect(s1.transientFailures).toBe(1);
      const row = await readJob(jobId);
      expect(row.status).toBe("running");
      expect(row.claimedBy).toBeNull();
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(clock.now().getTime());

      await scenario({ outage: { all: false } });
      clock.advance(TRANSIENT_WAIT_MS);
      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const calls = (await simState()).leaveCalls;
      expect(
        calls.filter((c) => c.status === 200).map((c) => c.accountId),
      ).toEqual(expect.arrayContaining([members[0]!.id]));
      expect(calls.filter((c) => c.accountId === members[0]!.id)).toHaveLength(
        1,
      );
    });
  });

  // ---- 群主已退后 kick → OWNER_LEFT（agent 的 kick_user 透传网关的码）--------------------------

  it("群主已退群后别人 kick → 网关 409 OWNER_LEFT（kick_user 原样透传）", async () => {
    const { creator, members, groupId, gatewayGroupId } = await readyGroup(1);
    const jobId = await startLeaveAll(groupId);
    await runToEnd(jobId);
    let caught: unknown;
    try {
      await gatewayClient.kick(gatewayGroupId, {
        byAccountId: members[0]!.id,
        targetPlatformUserId: creator.platformUserId!,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayResponseError);
    expect(caught as GatewayResponseError).toMatchObject({
      status: 409,
      code: "OWNER_LEFT",
    });
  });

  // ---- 完成后对账：网关里还有人（外部用户）→ 不一致记录可见、不阻断 ------------------------

  it("网关里还有外部用户：job 仍 finished，写一行 inconsistencies leave_all_members_mismatch + ws inconsistency", async () => {
    const { groupId, gatewayGroupId } = await readyGroup(1);
    const external = `ext-${randomUUID().slice(0, 6)}`;
    await gateway.inject({
      method: "POST",
      url: "/_sim/push",
      payload: {
        kind: "member_joined",
        groupId: gatewayGroupId,
        platformUserId: external,
      },
    });
    await pumpEvents();
    expect(
      (await localMembers(groupId)).map((m) => m.platformUserId),
    ).toContain(external);

    const jobId = await startLeaveAll(groupId);
    const job = await runToEnd(jobId);
    expect(job).toMatchObject({ status: "finished", errors: [] });
    // 本地：题目要求 members = []；网关：外部用户还在 → 差集非空 → 不一致记录
    expect(await localMembers(groupId)).toEqual([]);
    expect(
      (await simGroup(gatewayGroupId)).members.map((m) => m.platformUserId),
    ).toEqual([external]);
    const rows = await getDb().inconsistency.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "leave_all_members_mismatch",
      ref: jobId,
    });
    expect(rows[0]!.payload).toMatchObject({
      groupId,
      gatewayOnly: [external],
      localOnly: [],
    });
    const ws = await getDb().wsEvent.findMany({
      where: { type: "inconsistency" },
    });
    expect(ws).toHaveLength(1);
    expect(ws[0]!.payload).toMatchObject({
      inconsistencyId: rows[0]!.id,
      kind: "leave_all_members_mismatch",
    });
  });

  // ---- 业务边界 / 闸门 -----------------------------------------------------------------

  describe("边界与闸门", () => {
    it("viewer → 403 FORBIDDEN；未登录 → 401；不落 job", async () => {
      const { groupId } = await readyGroup(1);
      const forbidden = await postLeaveAll(groupId, viewer);
      expect(forbidden.statusCode).toBe(403);
      const forbiddenBody = forbidden.json<ErrorBody>();
      expect(forbiddenBody.error.code).toBe("FORBIDDEN");
      expect(typeof forbiddenBody.error.requestId).toBe("string");
      const anon = await postLeaveAll(groupId, {});
      expect(anon.statusCode).toBe(401);
      expect(anon.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
      expect(await getDb().job.count({ where: { kind: "leave_all" } })).toBe(0);
    });

    it("群不存在 → 404 GROUP_NOT_FOUND", async () => {
      const res = await postLeaveAll("nope");
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorBody>().error.code).toBe("GROUP_NOT_FOUND");
    });

    it("已 left 的群再 leave-all → 409 GROUP_ALREADY_LEFT", async () => {
      const { groupId } = await readyGroup(1);
      await runToEnd(await startLeaveAll(groupId));
      const res = await postLeaveAll(groupId);
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe("GROUP_ALREADY_LEFT");
    });

    it("网关里还没建成的群（gatewayGroupId 空）→ 409 GROUP_NOT_READY", async () => {
      const group = await makeGroup();
      const res = await postLeaveAll(group.id);
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe("GROUP_NOT_READY");
    });

    it("已有 running 的 job（另一个 leave-all 在跑）→ 409 JOB_ALREADY_RUNNING；结束后可以再发", async () => {
      const { groupId } = await readyGroup(1);
      const first = await startLeaveAll(groupId);
      const again = await postLeaveAll(groupId);
      expect(again.statusCode).toBe(409);
      expect(again.json<ErrorBody>().error.code).toBe("JOB_ALREADY_RUNNING");
      expect(await getDb().job.count({ where: { groupId } })).toBe(2); // 建群 + 第一个 leave-all
      await runToEnd(first);
      // 结束后群已 left：换成 GROUP_ALREADY_LEFT，而不是再建一个 job
      expect((await postLeaveAll(groupId)).json<ErrorBody>().error.code).toBe(
        "GROUP_ALREADY_LEFT",
      );
    });

    it("GET /api/jobs/:jobId：viewer 可读，形状含 kind = leave_all 与 leave:<accountId> 的 errors", async () => {
      const { members, groupId } = await readyGroup(1);
      await scenario({ leave: { failAccountIds: [members[0]!.id] } });
      const jobId = await startLeaveAll(groupId);
      await runToEnd(jobId);
      const res = await getJobApi(jobId, viewer);
      expect(res.statusCode).toBe(200);
      const body = res.json<JobBody>();
      expect(body).toMatchObject({
        id: jobId,
        kind: "leave_all",
        status: "failed",
        groupId,
        step: "leave",
        errors: [
          {
            step: `leave:${members[0]!.id}`,
            stepKind: "leave",
            accountId: members[0]!.id,
            code: "INTERNAL",
          },
        ],
      });
      expect(body.finishedAt).toEqual(expect.any(String));
    });
  });

  // ---- 重启恢复 ------------------------------------------------------------------------

  describe("重启恢复", () => {
    async function killWorker(jobId: string) {
      await getDb().job.update({
        where: { id: jobId },
        data: {
          claimedBy: "dead-worker",
          lockedAt: new Date(clock.now().getTime() - STALE_CLAIM_MS - 1),
        },
      });
    }

    it("第一个 leave 记账后死掉：新实例回收领取、从第二个账号继续，不重复 leave 同一账号", async () => {
      const { creator, members, groupId } = await readyGroup(2);
      const jobId = await startLeaveAll(groupId);
      await tick({ maxStepsPerJob: 1 }); // leave(m1) 完成并记账
      expect((await stateOf(jobId)).leaves[members[0]!.id]).toBe("left");
      await killWorker(jobId);

      const resumed = await runJobTick({
        clock,
        gateway: gatewayClient,
        workerId: "w2",
        log: silent,
        maxStepsPerJob: 1,
      });
      expect(resumed).toMatchObject({ recovered: 1, claimed: 1 });
      expect((await stateOf(jobId)).leaves[members[1]!.id]).toBe("left");

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const calls = (await simState()).leaveCalls;
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.accountId)).toEqual([
        members[0]!.id,
        members[1]!.id,
        creator.id,
      ]);
      expect((await getGroup(groupId)).json<GroupBody>()).toMatchObject({
        status: "left",
        members: [],
      });
    });

    it("死在「发出」与「记账」之间（calling）：新实例先查网关成员列表，已不在就不重发", async () => {
      const { members, groupId } = await readyGroup(2);
      const jobId = await startLeaveAll(groupId);
      await tick({ maxStepsPerJob: 1 }); // 网关已收到 leave(m1)
      // 把记账倒回去：像是死在 POST leave 返回之后、写 left 之前
      const s = await stateOf(jobId);
      await getDb().job.update({
        where: { id: jobId },
        data: {
          state: { ...s, leaves: { ...s.leaves, [members[0]!.id]: "calling" } },
        },
      });
      await killWorker(jobId);

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      const calls = (await simState()).leaveCalls;
      // m1 只被 leave 了一次（重启后靠成员列表确认已退）
      expect(calls.filter((c) => c.accountId === members[0]!.id)).toHaveLength(
        1,
      );
      expect(calls).toHaveLength(3);
    });

    it("群主已退、群已 left、收尾前死掉：新实例只做收尾，不再调 leave", async () => {
      const { groupId } = await readyGroup(1);
      const jobId = await startLeaveAll(groupId);
      await tick({ maxStepsPerJob: 2 }); // leave(m1) + leave(creator)
      expect((await getGroup(groupId)).json<GroupBody>().status).toBe("left");
      expect((await readJob(jobId)).status).toBe("running");
      await killWorker(jobId);

      const job = await runToEnd(jobId);
      expect(job).toMatchObject({ status: "finished", errors: [] });
      expect((await simState()).leaveCalls).toHaveLength(2);
      expect(await getDb().inconsistency.count()).toBe(0);
    });
  });
});

/** 网关不可用后第一次退避（base × 2^0）的等待：拨过它 job 才会再被领到 */
const TRANSIENT_WAIT_MS = 500;
