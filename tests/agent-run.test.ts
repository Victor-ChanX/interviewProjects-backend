// issue #12 / #13：agent run 循环（题目 2.2 协议 / A5 全部 12 条 / A2 错误表 OWNER_LEFT、NO_PERMISSION / S5 / S6）
// 与查询接口、ws 事件。
// 真库（tests/setup.ts 的临时 schema）；Agent 服务用 src/sim/agent 的 buildAgentApp、网关用 src/sim/gateway 的
// buildGatewayApp，都起在 listen(0) 上走真 HTTP（setup.ts 的 MockAgent 放行 localhost）。
// worker 不起循环：直接 await runAgentTick()（maxStepsPerTick 逐步驱动）；出站消息的派发在注入的 sleep 里跑
// runOutboxTick —— agent 等 deliveryStatus 时每轮询一次就派发一次、拨一次假时钟，不真等 5 秒。
// 时间：应用、service、worker、两个模拟器共用一个可拨动的假 Clock；只有 Agent 模拟器的 delay_ms（TURN_TIMEOUT 用例）
// 用可控的假 sleep，超时本身是客户端真等几百毫秒。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Account, AgentRun, Group } from "../src/db/generated/client.js";
import {
  type AgentClient,
  createAgentClient,
} from "../src/services/agent-client.js";
import {
  type Checkpoint,
  MAX_STEPS,
  onInboundMessage,
  RECENT_MESSAGES_MAX,
  RECENT_TEXT_MAX_CHARS,
  STALE_HEARTBEAT_MS,
} from "../src/services/agent-run-service.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { ingest } from "../src/services/inbound-service.js";
import { applyGatewayDelivery } from "../src/services/outbox-service.js";
import { buildAgentApp } from "../src/sim/agent/app.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { runAgentTick } from "../src/workers/agent-worker.js";
import { runOutboxTick } from "../src/workers/outbox-worker.js";
import { loginAs, makeAccount, makeGroup, makeMessage } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

/** 可拨动的假时钟：应用、worker、两个模拟器共用 */
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

/** Agent 模拟器 delay_ms 用的假 sleep：flush() 才放行 */
function makeSleep() {
  const calls: { ms: number; resolve: () => void }[] = [];
  return {
    calls,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        calls.push({ ms, resolve });
      }),
    flush: () => {
      for (const c of calls.splice(0)) c.resolve();
    },
  };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const silent = logger.child({}, { level: "silent" });

type AgentSimState = {
  runs: {
    runId: string;
    turns: number;
    sendKeys: string[];
    requests: { turn: number; messages: Json[]; responded: boolean }[];
  }[];
  audits: { groupId: string; text: string; mode: string }[];
};

type GatewaySimState = {
  sendCalls: { accountId: string; clientMsgId: string; status: number }[];
  messages: { msgId: string; clientMsgId: string | null }[];
};

describe("agent run（#12 / #13）", () => {
  const clock = fakeClock();
  const agentSleep = makeSleep();
  let app: FastifyInstance;
  let gatewaySim: FastifyInstance;
  let agentSim: FastifyInstance;
  let gatewayClient: GatewayClient;
  let agentClient: AgentClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
  let eventSeq = 0;

  beforeAll(async () => {
    gatewaySim = await buildGatewayApp({ logger: false, clock });
    const gatewayUrl = await gatewaySim.listen({ port: 0, host: "127.0.0.1" });
    gatewayClient = createGatewayClient({ baseUrl: gatewayUrl });
    agentSim = await buildAgentApp({
      logger: false,
      clock,
      sleep: agentSleep.sleep,
    });
    const agentUrl = await agentSim.listen({ port: 0, host: "127.0.0.1" });
    agentClient = createAgentClient({ baseUrl: agentUrl });
    app = await buildApp({ logger: false, gateway: gatewayClient });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    clock.reset();
    agentSleep.flush();
    eventSeq = 0;
    await gatewaySim.inject({ method: "POST", url: "/_sim/reset" });
    await agentSim.inject({ method: "POST", url: "/_sim/reset" });
    // 202 立刻回、事件立刻推、kick 立刻回：本文件不消费 SSE，只要模拟器的状态确定
    await gatewayScenario({
      send: { acceptDelayMs: 0, eventDelayMs: 0 },
      kick: { responseDelayMs: 0, timeout: null },
    });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    agentSleep.flush();
    await app.close();
    await agentSim.close();
    await gatewaySim.close();
    await closeDb();
  });

  // ---- 辅助 ------------------------------------------------------------------------------

  const gatewayScenario = (patch: Json) =>
    gatewaySim.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload: patch,
    });

  const agentScenario = async (payload: Json) => {
    const res = await agentSim.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload,
    });
    expect(res.statusCode).toBe(200);
  };

  const agentState = async (): Promise<AgentSimState> =>
    (await agentSim.inject({ method: "GET", url: "/_sim/state" })).json();

  const gatewayState = async (): Promise<GatewaySimState> =>
    (await gatewaySim.inject({ method: "GET", url: "/_sim/state" })).json();

  /** 网关视角的成员 platformUserId 列表 */
  const gatewayMembers = async (group: Group): Promise<string[]> =>
    (await gatewayClient.listMembers(group.gatewayGroupId ?? "")).map(
      (m) => m.platformUserId,
    );

  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gatewaySim.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  /** 布景：在线群主（本地 + 网关）建群（本地 + 网关），本地成员表写群主；默认 agentEnabled */
  async function stageGroup(
    overrides: { agentEnabled?: boolean; autoKickEnabled?: boolean } = {},
  ): Promise<{ group: Group; creator: Account }> {
    const creatorId = `acc-${randomUUID().slice(0, 8)}`;
    const platformUserId = await connectAtGateway(creatorId);
    const creator = await makeAccount({
      id: creatorId,
      status: "online",
      platformUserId,
    });
    const created = await gatewaySim.inject({
      method: "POST",
      url: "/groups",
      payload: { creatorAccountId: creatorId },
    });
    expect(created.statusCode).toBe(200);
    const { groupId } = created.json<{ groupId: string }>();
    const group = await makeGroup({
      creatorAccountId: creatorId,
      gatewayGroupId: groupId,
      agentEnabled: overrides.agentEnabled ?? true,
      autoKickEnabled: overrides.autoKickEnabled ?? false,
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

  /** 外部用户入群（网关 + 本地成员表） */
  async function addExternalMember(
    group: Group,
    platformUserId: string,
  ): Promise<void> {
    const joined = await gatewaySim.inject({
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
      data: { groupId: group.id, platformUserId, role: "member" },
    });
  }

  /** 插一条外部用户的入站消息并按 #12 的触发入口处理（与入站 service 同一事务形状） */
  async function trigger(group: Group, text = "有人吗", sender = "u-ext-1") {
    const msg = await makeMessage({
      groupId: group.id,
      msgId: `m-${randomUUID().slice(0, 8)}`,
      senderPlatformUserId: sender,
      isOwn: false,
      text,
      sentAt: clock.now(),
    });
    const outcome = await getDb().$transaction((tx) =>
      onInboundMessage(
        { groupId: group.id, messageId: msg.id },
        { tx, clock, log: silent },
      ),
    );
    return { message: msg, outcome };
  }

  /** 触发并返回新建 run 的 id */
  async function startRun(group: Group, text = "有人吗"): Promise<string> {
    const { outcome } = await trigger(group, text);
    expect(outcome.kind).toBe("run_created");
    if (outcome.kind !== "run_created") throw new Error("unreachable");
    return outcome.runId;
  }

  /** 走真正的入站入口（ingest）推一条 message 事件 */
  async function ingestMessage(
    group: Group,
    data: { senderPlatformUserId: string; text: string; msgId?: string },
    eventId = ++eventSeq,
  ) {
    return ingest(
      {
        eventId,
        type: "message",
        data: {
          groupId: group.gatewayGroupId,
          msgId: data.msgId ?? `m-${randomUUID().slice(0, 8)}`,
          senderPlatformUserId: data.senderPlatformUserId,
          text: data.text,
          sentAt: clock.now().toISOString(),
        },
      },
      { clock, log: silent, applyGatewayDelivery },
    );
  }

  const outboxTick = (workerId = "outbox-w1") =>
    runOutboxTick({ clock, gateway: gatewayClient, workerId, log: silent });

  /** agent 等待时的轮询：拨假时钟 + 派发一次出站 +（给模拟器的真定时器）几毫秒 */
  const pollSleep = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await realSleep(Math.max(1, Math.round(ms / 20)));
    await outboxTick();
  };

  type TickOpts = {
    workerId?: string;
    maxStepsPerTick?: number;
    checkpoint?: (point: Checkpoint) => Promise<void>;
    turnTimeoutMs?: number;
    auditTimeoutMs?: number;
  };
  const tick = (opts: TickOpts = {}) =>
    runAgentTick({
      clock,
      agent: agentClient,
      gateway: gatewayClient,
      workerId: opts.workerId ?? "agent-w1",
      log: silent,
      turnTimeoutMs: opts.turnTimeoutMs ?? 5_000,
      auditTimeoutMs: opts.auditTimeoutMs ?? 2_000,
      sleep: pollSleep,
      ...(opts.maxStepsPerTick !== undefined
        ? { maxStepsPerTick: opts.maxStepsPerTick }
        : {}),
      ...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
    });

  /** 一直 tick 到没有可领的 run（run 已终态），返回最后一次的结果 */
  async function runToEnd(opts: TickOpts = {}) {
    let last = null;
    for (let i = 0; i < 40; i += 1) {
      const r = await tick(opts);
      if (!r) break;
      last = r;
      if (r.outcome === "ended") break;
    }
    return last;
  }

  const run = (id: string) =>
    getDb().agentRun.findUniqueOrThrow({ where: { id } });
  const steps = (runId: string) =>
    getDb().agentStep.findMany({ where: { runId }, orderBy: { index: "asc" } });
  const runEvents = async () =>
    (
      await getDb().wsEvent.findMany({
        where: { type: "agent_run" },
        orderBy: { seq: "asc" },
      })
    ).map((e) => e.payload as Json);
  const parseContent = (s: string | null): Json =>
    JSON.parse(s ?? "null") as Json;

  const expectEnded = (
    r: AgentRun,
    status: AgentRun["status"],
    endReason: AgentRun["endReason"],
  ) => {
    expect(r.status).toBe(status);
    expect(r.endReason).toBe(endReason);
    expect(r.finishedAt).not.toBeNull();
    expect(r.claimedBy).toBeNull();
    expect(r.activeSince).toBeNull();
  };

  // ---- 主流程 -------------------------------------------------------------------------------

  describe("主流程", () => {
    it("默认剧本三轮：get_recent_messages → send_message → finish；steps 3、summary、finished/final、网关恰好一条", async () => {
      const { group } = await stageGroup();
      const runId = await startRun(group, "你好");

      const result = await runToEnd();
      expect(result?.outcome).toBe("ended");

      const r = await run(runId);
      expectEnded(r, "finished", "final");
      expect(r.summary).toBe("已处理（共 3 轮）");
      expect(r.stepCount).toBe(3);
      expect(r.consecutiveProtocolErrors).toBe(0);
      expect(r.accumulatedMs).toBeGreaterThanOrEqual(0);

      const s = await steps(runId);
      expect(s.map((x) => [x.index, x.kind, x.name, x.isError])).toEqual([
        [1, "tool_use", "get_recent_messages", false],
        [2, "tool_use", "send_message", false],
        [3, "final", "finish", false],
      ]);
      expect(
        s.every((x) => x.rawResponse !== null && x.completedAt !== null),
      ).toBe(true);
      expect(s[0]?.toolUseId).toBe("tu_1");
      expect(parseContent(s[0]?.resultContent ?? null)).toMatchObject({
        truncated: false,
        messages: [
          { text: "你好", isOwn: false, senderPlatformUserId: "u-ext-1" },
        ],
      });
      expect(parseContent(s[1]?.resultContent ?? null)).toMatchObject({
        deliveryStatus: "accepted",
      });
      expect(s[1]?.auditVerdict).toBe("pass");
      expect(s[1]?.auditAttempts).toBe(1);
      expect(parseContent(s[2]?.resultContent ?? null)).toEqual({ ok: true });

      // 网关恰好一条，幂等记录一条
      const gw = await gatewayState();
      expect(gw.sendCalls).toHaveLength(1);
      expect(await getDb().agentIdempotency.count({ where: { runId } })).toBe(
        1,
      );

      // 触发上下文（messages[0]）与历史重建
      const sim = await agentState();
      const session = sim.runs.find((x) => x.runId === runId);
      expect(session?.turns).toBe(3);
      const first = session?.requests[0]?.messages[0] as {
        role: string;
        content: { text: string }[];
      };
      expect(first.role).toBe("user");
      expect(JSON.parse(first.content[0]?.text ?? "")).toMatchObject({
        groupId: group.gatewayGroupId,
        triggerMessages: [{ text: "你好", senderPlatformUserId: "u-ext-1" }],
        policy: { autoKickEnabled: false },
      });
      // 第 3 轮请求带着前两步的 assistant tool_use + user tool_result
      const third = session?.requests[2]?.messages ?? [];
      expect(third).toHaveLength(5);
      expect(third.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);

      // ws 事件：创建 running → 结束 finished
      expect(await runEvents()).toEqual([
        { runId, groupId: group.id, status: "running", endReason: null },
        { runId, groupId: group.id, status: "finished", endReason: "final" },
      ]);
    });

    it("end_turn：text 存为 summary、不发到群里，run finished/final", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "end_turn", text: "无需回复。" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      const r = await run(runId);
      expectEnded(r, "finished", "final");
      expect(r.summary).toBe("无需回复。");
      const s = await steps(runId);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({
        kind: "final",
        toolUseId: null,
        name: null,
        input: null,
      });
      expect((await gatewayState()).sendCalls).toHaveLength(0);
    });
  });

  // ---- 触发（A5 第 1 条 / S2 / S3）-----------------------------------------------------------------

  describe("触发", () => {
    it("入站 message 事件（非自己）→ 创建 run；自己的消息与重复事件不触发；agentEnabled=false 不触发", async () => {
      const { group, creator } = await stageGroup();
      const r1 = await ingestMessage(group, {
        senderPlatformUserId: "u-ext-9",
        text: "hi",
        msgId: "m-1",
      });
      expect(r1.outcome).toBe("processed");
      expect(
        await getDb().agentRun.count({ where: { groupId: group.id } }),
      ).toBe(1);

      // S2：同一事件再推一次（同 eventId）→ duplicate；同 msgId 换 eventId 补投 → 不新建消息、不触发
      const dup = await ingestMessage(
        group,
        { senderPlatformUserId: "u-ext-9", text: "hi", msgId: "m-1" },
        1,
      );
      expect(dup.outcome).toBe("duplicate");
      await ingestMessage(group, {
        senderPlatformUserId: "u-ext-9",
        text: "hi",
        msgId: "m-1",
      });
      expect(
        await getDb().agentRun.count({ where: { groupId: group.id } }),
      ).toBe(1);
      expect(await getDb().agentPendingMessage.count()).toBe(0);

      // S3：自己的消息回流 isOwn = true → 不触发、不 pending
      await ingestMessage(group, {
        senderPlatformUserId: creator.platformUserId ?? "",
        text: "我自己发的",
      });
      expect(
        await getDb().agentRun.count({ where: { groupId: group.id } }),
      ).toBe(1);
      expect(await getDb().agentPendingMessage.count()).toBe(0);

      // agentEnabled = false 的群
      const off = await stageGroup({ agentEnabled: false });
      const { outcome } = await trigger(off.group);
      expect(outcome).toEqual({ kind: "ignored", reason: "agent_disabled" });
      expect(
        await getDb().agentRun.count({ where: { groupId: off.group.id } }),
      ).toBe(0);
    });

    it("run 期间到达的消息记为待处理；run 结束后立即建下一次 run，triggerMessages 含全部待处理（按 sentAt 升序）", async () => {
      const { group } = await stageGroup();
      const runId = await startRun(group, "第一条");
      // run 进行中（先跑一步）再来两条
      await tick({ maxStepsPerTick: 1 });
      clock.advance(10);
      const p1 = await trigger(group, "第二条", "u-a");
      clock.advance(10);
      const p2 = await trigger(group, "第三条", "u-b");
      expect(p1.outcome).toEqual({ kind: "pending", runId });
      expect(p2.outcome).toEqual({ kind: "pending", runId });
      expect(
        await getDb().agentPendingMessage.count({ where: { runId } }),
      ).toBe(2);
      expect(
        await getDb().agentRun.count({
          where: { groupId: group.id, status: "running" },
        }),
      ).toBe(1);

      await runToEnd();
      expectEnded(await run(runId), "finished", "final");

      const runs = await getDb().agentRun.findMany({
        where: { groupId: group.id },
        orderBy: { createdAt: "asc" },
      });
      expect(runs).toHaveLength(2);
      const next = runs[1]!;
      expect(next.status).toBe("running");
      expect(next.triggerMessages).toEqual([
        expect.objectContaining({ msgId: p1.message.msgId, text: "第二条" }),
        expect.objectContaining({ msgId: p2.message.msgId, text: "第三条" }),
      ]);
      // 第二次 run 也能正常跑完
      await runToEnd();
      expectEnded(await run(next.id), "finished", "final");
      const events = await runEvents();
      expect(
        events.filter((e) => e.runId === next.id).map((e) => e.status),
      ).toEqual(["running", "finished"]);
    });

    it("两实例并发触发同群：恰好一个 running，另一条成为它的待处理", async () => {
      const { group } = await stageGroup();
      const m1 = await makeMessage({
        groupId: group.id,
        msgId: "c-1",
        isOwn: false,
        sentAt: clock.now(),
      });
      const m2 = await makeMessage({
        groupId: group.id,
        msgId: "c-2",
        isOwn: false,
        sentAt: clock.now(),
      });
      const db = getDb();
      // T1 查过「没有 running」后停在 INSERT 之前；T2 此时完整跑完并提交 → T1 的 INSERT 撞部分唯一索引
      // （ON CONFLICT DO NOTHING），再绕一圈按 running 记 pending。两个事务各占一条连接，真并行。
      let releaseT1: () => void = () => undefined;
      const t2Done = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      const t1 = db.$transaction((tx) =>
        onInboundMessage(
          { groupId: group.id, messageId: m1.id },
          { tx, clock, log: silent, checkpoint: () => t2Done },
        ),
      );
      const t2 = db
        .$transaction((tx) =>
          onInboundMessage(
            { groupId: group.id, messageId: m2.id },
            { tx, clock, log: silent },
          ),
        )
        .finally(() => releaseT1());
      const [r1, r2] = await Promise.all([t1, t2]);
      expect(r2.kind).toBe("run_created");
      expect(r1).toEqual({
        kind: "pending",
        runId: r2.kind === "run_created" ? r2.runId : "",
      });
      expect(
        await db.agentRun.count({
          where: { groupId: group.id, status: "running" },
        }),
      ).toBe(1);
      expect(await db.agentPendingMessage.count()).toBe(1);
    });
  });

  // ---- S5 / 幂等 ---------------------------------------------------------------------------------

  describe("send_message 幂等（A5 第 7 条 / S5）", () => {
    it("S5：网关先 504、随后落地；同 key 再调 → 网关恰好一条、第二次返回 sent、审计只调一次", async () => {
      const { group } = await stageGroup();
      await gatewayScenario({
        send: { responses: [{ status: 504, landAfterMs: 20 }] },
      });
      await agentScenario({
        turn: {
          steps: [
            { type: "send_message", text: "hello" },
            { type: "send_message", reuse_key: true },
          ],
        },
      });
      const runId = await startRun(group);
      await runToEnd();

      const r = await run(runId);
      expectEnded(r, "finished", "final");
      const s = await steps(runId);
      expect(s.map((x) => [x.name, x.isError])).toEqual([
        ["send_message", false],
        ["send_message", false],
        ["finish", false],
      ]);
      const first = parseContent(s[0]?.resultContent ?? null);
      const second = parseContent(s[1]?.resultContent ?? null);
      expect(first.deliveryStatus).toBe("sent");
      expect(second).toEqual({
        clientMsgId: first.clientMsgId,
        deliveryStatus: "sent",
      });
      expect(s[1]?.auditVerdict).toBeNull();
      expect(s[1]?.auditAttempts).toBe(0);

      const gw = await gatewayState();
      expect(gw.messages).toHaveLength(1);
      expect(gw.sendCalls).toHaveLength(1);
      expect((await agentState()).audits).toHaveLength(1);
      expect(await getDb().agentIdempotency.count({ where: { runId } })).toBe(
        1,
      );
    });

    it("5 秒仍未确认 → SEND_TIMEOUT；同 key 再调返回当前状态，不再发、不再审", async () => {
      const { group } = await stageGroup();
      // 504 不落地且 by-client-id 不可用：outbox 只能保持 unknown（A2：查询不可用期间不重发）→ 5 秒后 agent 拿 SEND_TIMEOUT
      await gatewayScenario({
        send: { responses: [{ status: 504, landAfterMs: null }] },
        outage: { routes: ["by-client-id"] },
      });
      await agentScenario({
        turn: {
          steps: [
            { type: "send_message" },
            { type: "send_message", reuse_key: true },
          ],
        },
      });
      const runId = await startRun(group);
      await runToEnd();

      const s = await steps(runId);
      expect(s[0]).toMatchObject({ isError: true, errorCode: "SEND_TIMEOUT" });
      expect(parseContent(s[0]?.resultContent ?? null)).toMatchObject({
        code: "SEND_TIMEOUT",
      });
      const second = parseContent(s[1]?.resultContent ?? null);
      expect(second.deliveryStatus).toBe("unknown");
      expect(s[1]?.isError).toBe(false);
      // 网关只收到一次 send（确认不了就不重发），审计只调一次
      const gw = await gatewayState();
      expect(gw.sendCalls).toHaveLength(1);
      expect((await agentState()).audits).toHaveLength(1);
      expectEnded(await run(runId), "finished", "final");

      // 首发之后仍是 failed 的映射：由 outbox 之后按 A2 落定（重发一次仍未发出 → failed NETWORK_TIMEOUT）→ SEND_FAILED
      const b = await stageGroup();
      await gatewayScenario({
        send: {
          // 只对 b 的账号生效：a 的那条 unknown 在 by-client-id 恢复后会由 outbox 自行落定，不能吃掉这两条
          responses: [
            {
              status: 504,
              landAfterMs: null,
              match: { accountId: b.creator.id },
            },
            {
              status: 504,
              landAfterMs: null,
              match: { accountId: b.creator.id },
            },
          ],
        },
        outage: { routes: [] },
      });
      await agentSim.inject({ method: "POST", url: "/_sim/reset" });
      await agentScenario({ turn: { steps: [{ type: "send_message" }] } });
      const failedRun = await startRun(b.group);
      await runToEnd();
      expect((await steps(failedRun))[0]).toMatchObject({
        isError: true,
        errorCode: "SEND_FAILED",
      });
      const gw2 = await gatewayState();
      const calls = gw2.sendCalls.filter((c) => c.accountId === b.creator.id);
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((c) => c.clientMsgId)).size).toBe(1);
    });

    it("被 AUDIT_REJECTED 拒绝的调用不占 key：同 key 再调会重新审计并发送", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: {
          steps: [
            { type: "send_message" },
            { type: "send_message", reuse_key: true },
          ],
        },
        audit: {
          steps: [{ mode: "fail", reason: "不礼貌" }],
          fallback: { mode: "pass" },
        },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[0]).toMatchObject({
        isError: true,
        errorCode: "AUDIT_REJECTED",
        auditVerdict: "fail",
      });
      expect(s[1]).toMatchObject({ isError: false, auditVerdict: "pass" });
      expect(parseContent(s[1]?.resultContent ?? null).deliveryStatus).toBe(
        "accepted",
      );
      expect((await gatewayState()).sendCalls).toHaveLength(1);
      expect((await agentState()).audits).toHaveLength(2);
    });
  });

  // ---- S6 / 协议错误（A5 第 2、3 条）-------------------------------------------------------------------

  describe("协议错误", () => {
    it("S6：坏 JSON → 未知工具 → 正常结束；每步有 kind 与 rawResponse；服务不崩", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "invalid_json" }, { type: "unknown_tool" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      const r = await run(runId);
      expect(["final", "budget_exhausted", "protocol_errors"]).toContain(
        r.endReason,
      );
      expect(r.endReason).toBe("final");
      const s = await steps(runId);
      expect(s.map((x) => [x.kind, x.errorCode])).toEqual([
        ["protocol_error", "BAD_JSON"],
        ["tool_use", "UNKNOWN_TOOL"],
        ["final", null],
      ]);
      expect(
        s.every(
          (x) => typeof x.rawResponse === "string" && x.rawResponse.length > 0,
        ),
      ).toBe(true);
      expect(s[0]).toMatchObject({
        toolUseId: null,
        name: null,
        input: null,
        isError: true,
      });
      expect(s[0]?.resultContent).toMatch(/^PROTOCOL_ERROR BAD_JSON: /);
      expect(s[1]).toMatchObject({ name: "delete_group", isError: true });
      // 第 2 轮请求：协议错误以 user text 块追加，没有 assistant 块；第 3 轮请求含未知工具的 tool_use + is_error 结果
      const sim = await agentState();
      const session = sim.runs.find((x) => x.runId === runId)!;
      const second = session.requests[1]!.messages as {
        role: string;
        content: Json[];
      }[];
      expect(second).toHaveLength(2);
      expect(second[1]).toMatchObject({ role: "user" });
      expect((second[1]!.content[0] as { text: string }).text).toMatch(
        /^PROTOCOL_ERROR BAD_JSON: /,
      );
      const third = session.requests[2]!.messages as {
        role: string;
        content: Json[];
      }[];
      expect(third).toHaveLength(4);
      expect(third[2]).toMatchObject({ role: "assistant" });
      expect(third[3]!.content[0]).toMatchObject({
        type: "tool_result",
        is_error: true,
      });
      // 服务还活着
      expect(
        (await app.inject({ method: "GET", url: "/api/health" })).statusCode,
      ).toBe(200);
    });

    it("BAD_JSON 的每一种：非 2xx / 围栏 / 夹文字 / 缺 stop_reason / 块数 ≠ 1 / stop_reason 不符", async () => {
      const kinds = [
        "http_error",
        "markdown_fenced",
        "wrapped_text",
        "missing_stop_reason",
        "no_blocks",
        "two_blocks",
        "stop_reason_mismatch",
      ];
      for (const kind of kinds) {
        const { group } = await stageGroup();
        await agentSim.inject({ method: "POST", url: "/_sim/reset" });
        await agentScenario({ turn: { steps: [{ type: kind }] } });
        const runId = await startRun(group);
        await runToEnd();
        const s = await steps(runId);
        expect(s[0], kind).toMatchObject({
          kind: "protocol_error",
          errorCode: "BAD_JSON",
        });
        expectEnded(await run(runId), "finished", "final");
      }
    });

    it("同一个 tool_use.id 用两次 → DUPLICATE_TOOL_USE_ID 协议错误步，之后继续", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: {
          steps: [{ type: "get_recent_messages" }, { type: "duplicate_id" }],
        },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s.map((x) => [x.kind, x.errorCode])).toEqual([
        ["tool_use", null],
        ["protocol_error", "DUPLICATE_TOOL_USE_ID"],
        ["final", null],
      ]);
      expect(s[1]?.resultContent).toMatch(
        /PROTOCOL_ERROR DUPLICATE_TOOL_USE_ID: tool_use\.id tu_1/,
      );
      expectEnded(await run(runId), "finished", "final");
    });

    it("连续 3 次协议错误 → failed / protocol_errors；中间一次合法响应清零", async () => {
      const a = await stageGroup();
      await agentScenario({
        turn: {
          steps: [
            { type: "invalid_json" },
            { type: "markdown_fenced" },
            { type: "http_error" },
          ],
        },
      });
      const failedRun = await startRun(a.group);
      await runToEnd();
      const r = await run(failedRun);
      expectEnded(r, "failed", "protocol_errors");
      expect(r.stepCount).toBe(3);
      expect(r.consecutiveProtocolErrors).toBe(3);
      expect((await steps(failedRun)).map((s) => s.kind)).toEqual([
        "protocol_error",
        "protocol_error",
        "protocol_error",
      ]);

      // 清零：错 2 次、合法 1 次、再错 2 次 → 不到 3，正常 finish
      const b = await stageGroup();
      await agentSim.inject({ method: "POST", url: "/_sim/reset" });
      await agentScenario({
        turn: {
          steps: [
            { type: "invalid_json" },
            { type: "invalid_json" },
            { type: "get_recent_messages" },
            { type: "invalid_json" },
            { type: "invalid_json" },
          ],
        },
      });
      const okRun = await startRun(b.group);
      await runToEnd();
      const ok = await run(okRun);
      expectEnded(ok, "finished", "final");
      expect(ok.stepCount).toBe(6);
    });

    it("TURN_TIMEOUT：超时记协议错误，迟到的响应被丢弃，下一轮照常", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: {
          steps: [{ type: "finish", summary: "迟到的", delay_ms: 60_000 }],
        },
      });
      const runId = await startRun(group);

      const first = await tick({ maxStepsPerTick: 1, turnTimeoutMs: 200 });
      expect(first?.steps).toBe(1);
      let s = await steps(runId);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({
        kind: "protocol_error",
        errorCode: "TURN_TIMEOUT",
        isError: true,
      });
      expect((await run(runId)).status).toBe("running");

      // 迟到的响应现在才到：没人读它 —— 库里没有新步、run 没有变化
      expect(agentSleep.calls).toHaveLength(1);
      agentSleep.flush();
      await realSleep(20);
      s = await steps(runId);
      expect(s).toHaveLength(1);
      expect((await run(runId)).stepCount).toBe(1);

      // 第 2 轮：fallback finish（剧本 steps 用完）；请求里带着 PROTOCOL_ERROR TURN_TIMEOUT 的 user 块
      await runToEnd({ turnTimeoutMs: 5_000 });
      const r = await run(runId);
      expectEnded(r, "finished", "final");
      expect(r.summary).not.toBe("迟到的");
      const session = (await agentState()).runs.find((x) => x.runId === runId)!;
      expect(session.turns).toBe(2);
      const second = session.requests[1]!.messages as {
        role: string;
        content: { text?: string }[];
      }[];
      expect(second[1]!.content[0]!.text).toMatch(
        /^PROTOCOL_ERROR TURN_TIMEOUT: /,
      );
    });
  });

  // ---- 上限（A5 第 2 条）-----------------------------------------------------------------------------

  describe("上限", () => {
    it("一直调工具不结束 → 12 步后 failed / budget_exhausted；连续相同入参从第 3 次起附 hint", async () => {
      const { group } = await stageGroup();
      await agentScenario({ turn: { steps: [], fallback: "loop_tools" } });
      const runId = await startRun(group);
      await runToEnd();
      const r = await run(runId);
      expectEnded(r, "failed", "budget_exhausted");
      expect(r.stepCount).toBe(MAX_STEPS);
      const s = await steps(runId);
      expect(s).toHaveLength(MAX_STEPS);
      expect(
        s.every((x) => x.name === "get_recent_messages" && !x.isError),
      ).toBe(true);
      const hints = s.map(
        (x) => typeof parseContent(x.resultContent).hint === "string",
      );
      expect(hints).toEqual([
        false,
        false,
        ...Array<boolean>(MAX_STEPS - 2).fill(true),
      ]);
      expect((await agentState()).runs[0]?.turns).toBe(MAX_STEPS);
    });

    it("第 12 步是 finish → 正常 finished（上限含结束那一步）", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: {
          steps: [{ type: "get_recent_messages", repeat: MAX_STEPS - 1 }],
          fallback: "finish",
        },
      });
      const runId = await startRun(group);
      await runToEnd();
      const r = await run(runId);
      expectEnded(r, "finished", "final");
      expect(r.stepCount).toBe(MAX_STEPS);
    });

    it("60 秒墙钟（按落库时间戳）→ failed / wall_clock；停机期间不计", async () => {
      // 停机不计：一步之后释放，时钟拨过 61s 再接着跑 → 照常 finish
      const a = await stageGroup();
      const idle = await startRun(a.group);
      await tick({ maxStepsPerTick: 1 });
      clock.advance(61_000);
      await runToEnd();
      const idleRun = await run(idle);
      expectEnded(idleRun, "finished", "final");
      expect(idleRun.accumulatedMs).toBeLessThan(60_000);

      // 运行中过了 61s（turn 之前拨时钟，这一步仍执行）→ 这一步之后 wall_clock
      const b = await stageGroup();
      const busy = await startRun(b.group);
      let bumped = false;
      await runToEnd({
        checkpoint: async (point) => {
          if (point === "before_turn" && !bumped) {
            bumped = true;
            clock.advance(61_000);
          }
        },
      });
      const busyRun = await run(busy);
      expectEnded(busyRun, "failed", "wall_clock");
      expect(busyRun.stepCount).toBe(1);
      expect(busyRun.accumulatedMs).toBeGreaterThanOrEqual(60_000);
    });
  });

  // ---- 审计（A5 第 4 条）-------------------------------------------------------------------------------

  describe("审计", () => {
    it("审计 fail → AUDIT_REJECTED，不发送；run 继续并正常结束", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        audit: { fallback: { mode: "fail", reason: "广告" } },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[1]).toMatchObject({
        name: "send_message",
        isError: true,
        errorCode: "AUDIT_REJECTED",
        auditVerdict: "fail",
        auditAttempts: 1,
      });
      expect((await gatewayState()).sendCalls).toHaveLength(0);
      expect(await getDb().agentIdempotency.count()).toBe(0);
      expectEnded(await run(runId), "finished", "final");
      const audits = (await agentState()).audits;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        groupId: group.gatewayGroupId,
        text: "自动回复（第 2 轮）",
      });
    });

    it.each([
      ["http_500", { mode: "http_500" }],
      ["invalid_json", { mode: "invalid_json" }],
      ["no_verdict", { mode: "no_verdict" }],
      ["other_verdict", { mode: "other_verdict" }],
    ])(
      "审计拿不到结论（%s）3 次 → run blocked / audit_blocked，工具不执行，推 ws 事件",
      async (_name, step) => {
        const { group } = await stageGroup();
        await agentScenario({ audit: { fallback: step } });
        const runId = await startRun(group);
        await runToEnd();
        const r = await run(runId);
        expectEnded(r, "blocked", "audit_blocked");
        expect(r.stepCount).toBe(2);
        const s = await steps(runId);
        expect(s[1]).toMatchObject({
          name: "send_message",
          isError: false,
          auditVerdict: null,
          auditAttempts: 3,
          resultContent: null,
        });
        expect(s[1]?.completedAt).not.toBeNull();
        expect((await agentState()).audits).toHaveLength(3);
        expect((await gatewayState()).sendCalls).toHaveLength(0);
        const events = await runEvents();
        expect(events[events.length - 1]).toEqual({
          runId,
          groupId: group.id,
          status: "blocked",
          endReason: "audit_blocked",
        });
      },
    );

    it("审计超时也算拿不到结论；两次超时后第 3 次 pass 则执行（重试不计步）", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        audit: {
          steps: [
            { mode: "pass", delay_ms: 60_000 },
            { mode: "pass", delay_ms: 60_000 },
          ],
          fallback: { mode: "pass" },
        },
      });
      const runId = await startRun(group);
      await runToEnd({ auditTimeoutMs: 150 });
      agentSleep.flush();
      const r = await run(runId);
      expectEnded(r, "finished", "final");
      expect(r.stepCount).toBe(3);
      const s = await steps(runId);
      expect(s[1]).toMatchObject({
        auditVerdict: "pass",
        auditAttempts: 3,
        isError: false,
      });
      expect((await gatewayState()).sendCalls).toHaveLength(1);
    });
  });

  // ---- 工具 ---------------------------------------------------------------------------------------------

  describe("get_recent_messages", () => {
    it("limit 上限 50、按 sentAt 升序、含触发消息与 run 期间新到的消息、text 超 500 截断并置 truncated", async () => {
      const { group } = await stageGroup();
      const longText = "长".repeat(RECENT_TEXT_MAX_CHARS + 5);
      for (let i = 0; i < 60; i += 1) {
        clock.advance(1);
        await makeMessage({
          groupId: group.id,
          msgId: `old-${i}`,
          isOwn: false,
          text: `old ${i}`,
          sentAt: clock.now(),
        });
      }
      clock.advance(1);
      const runId = await startRun(group, longText);
      // run 期间新到的一条
      clock.advance(1);
      const late = await makeMessage({
        groupId: group.id,
        msgId: "late",
        isOwn: false,
        text: "新到",
        sentAt: clock.now(),
      });
      await agentScenario({ turn: { steps: [{ type: "huge_limit" }] } });
      await runToEnd();
      const s = await steps(runId);
      expect(s[0]).toMatchObject({
        name: "get_recent_messages",
        isError: false,
      });
      const content = parseContent(s[0]?.resultContent ?? null) as {
        messages: { msgId: string; text: string; sentAt: string }[];
        truncated: boolean;
      };
      expect(content.messages).toHaveLength(RECENT_MESSAGES_MAX);
      expect(content.truncated).toBe(true);
      const sentAts = content.messages.map((m) => m.sentAt);
      expect([...sentAts].sort()).toEqual(sentAts);
      expect(content.messages[content.messages.length - 1]?.msgId).toBe(
        late.msgId,
      );
      const trig = content.messages.find((m) => m.text.startsWith("长"))!;
      expect(Array.from(trig.text)).toHaveLength(RECENT_TEXT_MAX_CHARS);
      expect(Buffer.byteLength(s[0]?.resultContent ?? "")).toBeLessThanOrEqual(
        8 * 1024,
      );
      expect((s[0]?.resultSummary ?? "").length).toBeLessThanOrEqual(200);
    });

    it("入参不合 schema → INVALID_INPUT（追加 assistant 块，不算协议错误）", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "invalid_input", name: "send_message" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[0]).toMatchObject({
        kind: "tool_use",
        name: "send_message",
        isError: true,
        errorCode: "INVALID_INPUT",
      });
      const r = await run(runId);
      expect(r.consecutiveProtocolErrors).toBe(0);
      expectEnded(r, "finished", "final");
      expect((await agentState()).audits).toHaveLength(0);
    });
  });

  describe("send_message 的执行账号与失败", () => {
    it("没有 online 的群成员 → NO_AVAILABLE_ACCOUNT（计步、不算协议错误）", async () => {
      const { group, creator } = await stageGroup();
      await getDb().account.update({
        where: { id: creator.id },
        data: { status: "disconnected" },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[1]).toMatchObject({
        name: "send_message",
        isError: true,
        errorCode: "NO_AVAILABLE_ACCOUNT",
      });
      const r = await run(runId);
      expect(r.consecutiveProtocolErrors).toBe(0);
      expectEnded(r, "finished", "final");
      expect((await gatewayState()).sendCalls).toHaveLength(0);
    });

    it("账号执行中途被判终态（网关 403 ACCOUNT_SUSPENDED）→ SEND_FAILED，run 继续", async () => {
      const { group, creator } = await stageGroup();
      await gatewayScenario({
        send: {
          responses: [
            { status: 403, code: "ACCOUNT_SUSPENDED", pushStatusEvent: false },
          ],
        },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[1]).toMatchObject({
        name: "send_message",
        isError: true,
        errorCode: "SEND_FAILED",
      });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: creator.id } }))
          .status,
      ).toBe("suspended");
      expectEnded(await run(runId), "finished", "final");
    });

    it("群不可写（GROUP_WRITE_FORBIDDEN）→ GROUP_UNREACHABLE；群变 unreachable 后 run 在当前步后 cancelled", async () => {
      const { group } = await stageGroup();
      await gatewayScenario({
        send: { responses: [{ status: 403, code: "GROUP_WRITE_FORBIDDEN" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[1]).toMatchObject({
        name: "send_message",
        isError: true,
        errorCode: "GROUP_UNREACHABLE",
      });
      expect(
        (await getDb().group.findUniqueOrThrow({ where: { id: group.id } }))
          .status,
      ).toBe("unreachable");
      const r = await run(runId);
      expectEnded(r, "cancelled", "cancelled");
      expect(r.stepCount).toBe(2);
    });
  });

  describe("kick_user", () => {
    it("autoKickEnabled=false → POLICY_DENIED，不审计、不调网关", async () => {
      const { group } = await stageGroup({ autoKickEnabled: false });
      await addExternalMember(group, "u-spam");
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[0]).toMatchObject({
        name: "kick_user",
        isError: true,
        errorCode: "POLICY_DENIED",
      });
      expect((await agentState()).audits).toHaveLength(0);
      expect(await gatewayMembers(group)).toContain("u-spam");
      expectEnded(await run(runId), "finished", "final");
    });

    it("群主在线 + autoKickEnabled → 审计 text 为 JSON.stringify({ action: 'kick', … })，网关移除成员，返回 { kicked: true }", async () => {
      const { group } = await stageGroup({ autoKickEnabled: true });
      await addExternalMember(group, "u-spam");
      await agentScenario({
        turn: {
          steps: [
            { type: "kick_user", platform_user_id: "u-spam", reason: "刷屏" },
          ],
        },
      });
      const runId = await startRun(group);
      await runToEnd();
      const s = await steps(runId);
      expect(s[0]).toMatchObject({
        name: "kick_user",
        isError: false,
        auditVerdict: "pass",
      });
      expect(parseContent(s[0]?.resultContent ?? null)).toEqual({
        kicked: true,
      });
      expect(s[0]?.toolStartedAt).not.toBeNull();
      const audits = (await agentState()).audits;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.text).toBe(
        JSON.stringify({
          action: "kick",
          platform_user_id: "u-spam",
          reason: "刷屏",
        }),
      );
      expect(await gatewayMembers(group)).not.toContain("u-spam");
      expectEnded(await run(runId), "finished", "final");
    });

    it("没有 online 的群主 / 管理员 → NO_AVAILABLE_ACCOUNT；普通成员在线也不行", async () => {
      const { group, creator } = await stageGroup({ autoKickEnabled: true });
      await getDb().account.update({
        where: { id: creator.id },
        data: { status: "disconnected" },
      });
      const memberId = `acc-${randomUUID().slice(0, 8)}`;
      const pu = await connectAtGateway(memberId);
      await makeAccount({ id: memberId, status: "online", platformUserId: pu });
      await getDb().groupMember.create({
        data: {
          groupId: group.id,
          platformUserId: pu,
          accountId: memberId,
          role: "member",
        },
      });
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-x" }] },
      });
      const runId = await startRun(group);
      await runToEnd();
      expect((await steps(runId))[0]).toMatchObject({
        isError: true,
        errorCode: "NO_AVAILABLE_ACCOUNT",
      });
    });

    it("OWNER_LEFT / NO_PERMISSION 透传同名错误；账号、群状态不变", async () => {
      // OWNER_LEFT：群主在网关侧已退群
      const a = await stageGroup({ autoKickEnabled: true });
      await addExternalMember(a.group, "u-spam");
      const left = await gatewaySim.inject({
        method: "POST",
        url: `/groups/${a.group.gatewayGroupId}/leave`,
        payload: { accountId: a.creator.id },
      });
      expect(left.statusCode).toBe(200);
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const ownerLeftRun = await startRun(a.group);
      await runToEnd();
      expect((await steps(ownerLeftRun))[0]).toMatchObject({
        isError: true,
        errorCode: "OWNER_LEFT",
      });
      expect(
        (await getDb().group.findUniqueOrThrow({ where: { id: a.group.id } }))
          .status,
      ).toBe("active");
      expect(
        (
          await getDb().account.findUniqueOrThrow({
            where: { id: a.creator.id },
          })
        ).status,
      ).toBe("online");

      // NO_PERMISSION：本地是 admin、网关侧没被 promote 的成员
      const b = await stageGroup({ autoKickEnabled: true });
      await getDb().account.update({
        where: { id: b.creator.id },
        data: { status: "disconnected" },
      });
      const adminId = `acc-${randomUUID().slice(0, 8)}`;
      const pu = await connectAtGateway(adminId);
      await makeAccount({ id: adminId, status: "online", platformUserId: pu });
      await gatewaySim.inject({
        method: "POST",
        url: "/_sim/push",
        payload: {
          kind: "member_joined",
          groupId: b.group.gatewayGroupId,
          platformUserId: pu,
        },
      });
      await getDb().groupMember.create({
        data: {
          groupId: b.group.id,
          platformUserId: pu,
          accountId: adminId,
          role: "admin",
        },
      });
      await addExternalMember(b.group, "u-spam");
      await agentSim.inject({ method: "POST", url: "/_sim/reset" });
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const noPermRun = await startRun(b.group);
      await runToEnd();
      expect((await steps(noPermRun))[0]).toMatchObject({
        isError: true,
        errorCode: "NO_PERMISSION",
      });
      expect(
        (await getDb().account.findUniqueOrThrow({ where: { id: adminId } }))
          .status,
      ).toBe("online");
      expectEnded(await run(noPermRun), "finished", "final");
    });

    it("网关 504：用成员列表在 2 秒内收敛 —— 已移除 → { kicked: true }；未移除 → 错误", async () => {
      const a = await stageGroup({ autoKickEnabled: true });
      await addExternalMember(a.group, "u-spam");
      await gatewayScenario({
        kick: {
          responseDelayMs: 0,
          timeout: { removed: true, convergeAfterMs: 30 },
        },
      });
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const removed = await startRun(a.group);
      await runToEnd();
      expect((await steps(removed))[0]).toMatchObject({ isError: false });
      expect(
        parseContent((await steps(removed))[0]?.resultContent ?? null),
      ).toEqual({ kicked: true });

      const b = await stageGroup({ autoKickEnabled: true });
      await addExternalMember(b.group, "u-spam");
      await gatewayScenario({
        kick: {
          responseDelayMs: 0,
          timeout: { removed: false, convergeAfterMs: 0 },
        },
      });
      await agentSim.inject({ method: "POST", url: "/_sim/reset" });
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const kept = await startRun(b.group);
      await runToEnd();
      expect((await steps(kept))[0]).toMatchObject({
        isError: true,
        errorCode: "GROUP_UNREACHABLE",
      });
      expect(await gatewayMembers(b.group)).toContain("u-spam");
    });
  });

  // ---- 外部状态（A5 第 10 条）-------------------------------------------------------------------------

  describe("外部状态变化", () => {
    it("agentEnabled 被关闭 → 当前步之后 cancelled；pending 的消息不再触发", async () => {
      const { group } = await stageGroup();
      await agentScenario({ turn: { steps: [], fallback: "loop_tools" } });
      const runId = await startRun(group);
      await tick({ maxStepsPerTick: 1 });
      await trigger(group, "run 期间来的");
      await getDb().group.update({
        where: { id: group.id },
        data: { agentEnabled: false },
      });
      await runToEnd();
      const r = await run(runId);
      expectEnded(r, "cancelled", "cancelled");
      expect(r.stepCount).toBeLessThanOrEqual(2);
      expect(
        await getDb().agentRun.count({ where: { groupId: group.id } }),
      ).toBe(1);
      const events = await runEvents();
      expect(events[events.length - 1]).toMatchObject({
        runId,
        status: "cancelled",
        endReason: "cancelled",
      });
    });
  });

  // ---- 重启恢复（A5 第 8 条）+ 多副本 ------------------------------------------------------------------------

  describe("重启恢复", () => {
    const crashAt = (point: Checkpoint) => {
      let armed = true;
      return async (p: Checkpoint) => {
        if (p === point && armed) {
          armed = false;
          throw new Error(`simulated crash at ${point}`);
        }
      };
    };

    it("turn 返回落库后、执行工具前死掉：新实例续跑 → 审计一次、网关恰好一条、步骤不重复", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "send_message", text: "恢复" }] },
      });
      const runId = await startRun(group);

      const crashed = await tick({
        workerId: "w-dead",
        checkpoint: crashAt("after_turn_persisted"),
      });
      expect(crashed?.runId).toBe(runId);
      let s = await steps(runId);
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({
        name: "send_message",
        completedAt: null,
        toolStartedAt: null,
        auditAttempts: 0,
      });
      expect(await getDb().agentIdempotency.count()).toBe(0);
      const mid = await run(runId);
      expect(mid.status).toBe("running");
      expect(mid.claimedBy).toBeNull();

      await runToEnd({ workerId: "w-new" });
      expectEnded(await run(runId), "finished", "final");
      s = await steps(runId);
      expect(s.map((x) => [x.index, x.name, x.isError])).toEqual([
        [1, "send_message", false],
        [2, "finish", false],
      ]);
      expect(parseContent(s[0]?.resultContent ?? null)).toMatchObject({
        deliveryStatus: "accepted",
      });
      expect((await gatewayState()).sendCalls).toHaveLength(1);
      expect((await agentState()).audits).toHaveLength(1);
      expect((await agentState()).runs[0]?.turns).toBe(2);
    });

    it("send 入队后、记结果前死掉：新实例按 agent_idempotency 只等结果，不再入队、不再审计", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "send_message", text: "恢复" }] },
      });
      const runId = await startRun(group);

      await tick({ workerId: "w-dead", checkpoint: crashAt("after_enqueue") });
      let s = await steps(runId);
      expect(s[0]).toMatchObject({
        name: "send_message",
        completedAt: null,
        auditVerdict: "pass",
      });
      expect(s[0]?.toolStartedAt).not.toBeNull();
      const idem = await getDb().agentIdempotency.findMany({
        where: { runId },
      });
      expect(idem).toHaveLength(1);

      await runToEnd({ workerId: "w-new" });
      expectEnded(await run(runId), "finished", "final");
      s = await steps(runId);
      expect(s).toHaveLength(2);
      expect(s[0]).toMatchObject({ isError: false, auditAttempts: 1 });
      expect(parseContent(s[0]?.resultContent ?? null)).toMatchObject({
        clientMsgId: idem[0]?.clientMsgId,
        deliveryStatus: "accepted",
      });
      expect((await gatewayState()).sendCalls).toHaveLength(1);
      expect((await agentState()).audits).toHaveLength(1);
      expect(await getDb().agentIdempotency.count({ where: { runId } })).toBe(
        1,
      );
    });

    it("kick 发出后、记结果前死掉：新实例按网关成员列表确认已移除，不再 kick 一次", async () => {
      const { group } = await stageGroup({ autoKickEnabled: true });
      await addExternalMember(group, "u-spam");
      await agentScenario({
        turn: { steps: [{ type: "kick_user", platform_user_id: "u-spam" }] },
      });
      const runId = await startRun(group);
      // before_kick 在 toolStartedAt 写入之后、调网关之前；这里先让网关真的移除再「死」，模拟死在响应之前
      await tick({
        workerId: "w-dead",
        checkpoint: async (p) => {
          if (p === "before_kick") {
            await gatewayClient.kick(group.gatewayGroupId!, {
              byAccountId: group.creatorAccountId,
              targetPlatformUserId: "u-spam",
            });
            throw new Error("simulated crash before kick response");
          }
        },
      });
      expect((await steps(runId))[0]?.toolStartedAt).not.toBeNull();
      await runToEnd({ workerId: "w-new" });
      const s = await steps(runId);
      expect(parseContent(s[0]?.resultContent ?? null)).toEqual({
        kicked: true,
      });
      expect(s[0]?.isError).toBe(false);
      expectEnded(await run(runId), "finished", "final");
    });

    it("心跳过期的 run 被别的副本接手，只折算心跳还活着的那段", async () => {
      const { group } = await stageGroup();
      const runId = await startRun(group);
      const t0 = clock.now();
      await getDb().agentRun.update({
        where: { id: runId },
        data: {
          claimedBy: "w-dead",
          activeSince: t0,
          heartbeatAt: new Date(t0.getTime() + 1_000),
        },
      });
      // 心跳没过期：别的副本领不到
      clock.advance(STALE_HEARTBEAT_MS - 5_000);
      expect(await tick({ workerId: "w-2" })).toBeNull();
      // 过期后接手，从中断处跑完；死掉那段（心跳后到现在）不计预算
      clock.advance(10_000);
      const r = await runToEnd({ workerId: "w-2" });
      expect(r?.runId).toBe(runId);
      const done = await run(runId);
      expectEnded(done, "finished", "final");
      expect(done.accumulatedMs).toBeLessThan(5_000);
    });
  });

  // ---- #13 查询接口 ----------------------------------------------------------------------------------

  describe("GET /api/agent-runs/:id、GET /api/groups/:id/agent-runs", () => {
    it("详情形状（含协议错误步）；viewer 可读；未登录 401；不存在 404 AGENT_RUN_NOT_FOUND", async () => {
      const { group } = await stageGroup();
      await agentScenario({
        turn: {
          steps: [{ type: "invalid_json" }, { type: "get_recent_messages" }],
        },
      });
      const runId = await startRun(group, "hi");
      await runToEnd();

      const res = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${runId}`,
        headers: viewer,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();
      expect(body).toMatchObject({
        id: runId,
        groupId: group.id,
        status: "finished",
        endReason: "final",
        summary: "已处理（共 3 轮）",
        stepCount: 3,
        maxSteps: 12,
        budgetMs: 60_000,
        triggerMessages: [{ text: "hi", senderPlatformUserId: "u-ext-1" }],
      });
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.finishedAt).toBe("string");
      const stepsOut = body.steps as Json[];
      expect(stepsOut).toHaveLength(3);
      expect(stepsOut[0]).toMatchObject({
        index: 1,
        kind: "protocol_error",
        toolUseId: null,
        name: null,
        input: null,
        isError: true,
        errorCode: "BAD_JSON",
        auditVerdict: null,
      });
      expect(typeof stepsOut[0]?.rawResponse).toBe("string");
      expect(stepsOut[1]).toMatchObject({
        index: 2,
        kind: "tool_use",
        toolUseId: "tu_1",
        name: "get_recent_messages",
        input: { limit: 10 },
        isError: false,
        errorCode: null,
      });
      expect(typeof stepsOut[1]?.resultSummary).toBe("string");
      expect(stepsOut[2]).toMatchObject({
        index: 3,
        kind: "final",
        name: "finish",
      });
      for (const st of stepsOut) {
        expect(Object.keys(st)).toEqual(
          expect.arrayContaining([
            "kind",
            "toolUseId",
            "name",
            "input",
            "resultSummary",
            "isError",
            "errorCode",
            "auditVerdict",
            "rawResponse",
          ]),
        );
      }

      const noAuth = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${runId}`,
      });
      expect(noAuth.statusCode).toBe(401);
      const missing = await app.inject({
        method: "GET",
        url: "/api/agent-runs/nope",
        headers: admin,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: { code: string } }>().error.code).toBe(
        "AGENT_RUN_NOT_FOUND",
      );
    });

    it("群的最近列表：{ items, total }，最新在前、不含 steps；群不存在 404 GROUP_NOT_FOUND", async () => {
      const { group } = await stageGroup();
      const first = await startRun(group, "1");
      await runToEnd();
      clock.advance(1_000);
      const second = await startRun(group, "2");
      await runToEnd();

      const res = await app.inject({
        method: "GET",
        url: `/api/groups/${group.id}/agent-runs`,
        headers: viewer,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Json[]; total: number }>();
      expect(body.total).toBe(2);
      expect(body.items.map((i) => i.id)).toEqual([second, first]);
      expect(body.items[0]).not.toHaveProperty("steps");
      expect(body.items[0]).toMatchObject({
        status: "finished",
        endReason: "final",
      });

      const missing = await app.inject({
        method: "GET",
        url: "/api/groups/nope/agent-runs",
        headers: admin,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: { code: string } }>().error.code).toBe(
        "GROUP_NOT_FOUND",
      );
    });
  });
});
