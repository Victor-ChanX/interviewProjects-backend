// issue #14：题目 2.4 的 S5 / S6 + A5 第 8 条（重启恢复）+ 多副本并发，端到端串联。
//
// 与 tests/agent-run.test.ts 的区别：那里触发是直接调 onInboundMessage、出站派发塞在注入的 sleep 里、agent 用
// runAgentTick 手动逐步驱动。这里按 src/main.ts 的接法把整条链真跑起来：网关模拟器推 SSE → startInboundWorker
// （consumeOnce）→ ingest → 自动建 run → startAgentWorker 领取并逐步执行 → send_message 入队 → startOutboxWorker
// 调网关 → 网关落地推 message_sent / 回流 message → 入站 worker 记账 → agent 从 messages 表看到 sent。
// 断言同时看库（agent_runs / agent_steps / agent_idempotency / messages）、网关 /_sim/state（sendCalls /
// messages：外部效果的**次数**）与 Agent 模拟器 /_sim/state（audits / 每轮请求的 messages 历史）。
//
// 时间：三个 worker 的轮询间隔都是真定时器（几十毫秒），所以本文件的 Clock 跟着真实时间走、只带一个可拨的偏移
// （offset）—— 这样 S5「504 之后 1.5 秒落地」用网关模拟器的真定时器，agent 的 5 秒等待与 outbox 的 2 秒确认窗
// 按同一把时钟算，不会出现「假时钟拨到 5 秒了、网关的 1.5 秒还没到」。等待条件成立一律短轮询（waitFor），不等
// 固定时长。真库（tests/setup.ts 的临时 schema）；两个模拟器起在 listen(0) 上走真 HTTP / 真 SSE。
import { randomUUID } from "node:crypto";

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
import type { Account, AgentRun, Group } from "../src/db/generated/client.js";
import {
  type AgentClient,
  createAgentClient,
} from "../src/services/agent-client.js";
import type { Checkpoint } from "../src/services/agent-run-service.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { advanceCursor, ingest } from "../src/services/inbound-service.js";
import { applyGatewayDelivery } from "../src/services/outbox-service.js";
import { buildAgentApp } from "../src/sim/agent/app.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import {
  type AgentWorkerHandle,
  runAgentTick,
  startAgentWorker,
} from "../src/workers/agent-worker.js";
import {
  abortableSleep,
  startInboundWorker,
} from "../src/workers/inbound-worker.js";
import { startOutboxWorker } from "../src/workers/outbox-worker.js";
import { loginAs, makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const silent = logger.child({}, { level: "silent" });

/** 各 worker「多久看一次」（真定时器） */
const WORKER_INTERVAL_MS = 20;
/** 题目 S5：网关 send 返回 504，但消息实际在 1.5 秒后落地 */
const S5_LAND_AFTER_MS = 1_500;
/** 单个用例的上限：S5 要真等 1.5 秒落地 + 各 worker 的轮询，留足余量 */
const CASE_TIMEOUT_MS = 20_000;

/** 跟着真实时间走、可拨偏移的时钟：应用、三个 worker、两个模拟器共用 */
function liveClock(): Clock & { advance(ms: number): void; reset(): void } {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms) {
      offset += ms;
    },
    reset() {
      offset = 0;
    },
  };
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 短轮询等条件成立（真定时器；不等固定时长） */
async function waitFor(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await realSleep(15);
  }
  throw new Error(`等待超时：${what}`);
}

/** 一个外部可 resolve 的门：checkpoint / sleep 钩子在门上等，测试决定什么时候放行 */
function makeGate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

type AgentSimState = {
  runs: {
    runId: string;
    turns: number;
    sendKeys: string[];
    requests: {
      turn: number;
      messages: { role: string; content: Json[] }[];
      responded: boolean;
    }[];
  }[];
  audits: { groupId: string; text: string; mode: string }[];
};

type GatewaySimState = {
  sendCalls: { accountId: string; clientMsgId: string; status: number }[];
  messages: {
    msgId: string;
    clientMsgId: string | null;
    senderPlatformUserId: string;
    text: string;
  }[];
  events: { lastEventId: number; byType: Record<string, number> };
  streams: { open: number };
};

describe("S5 / S6 / 重启恢复 / 并发（#14，入站 → agent → 出站 → 网关 → 回流全链路）", () => {
  const clock = liveClock();
  let app: FastifyInstance;
  let gatewaySim: FastifyInstance;
  let agentSim: FastifyInstance;
  let gatewayClient: GatewayClient;
  let agentClient: AgentClient;
  let admin: Record<string, string>;
  /** 本用例起的 worker；afterEach 先停 agent（在途的步要等 outbox / 入站把结果送到）再停其余 */
  let agentWorkers: AgentWorkerHandle[] = [];
  let otherStoppers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    gatewaySim = await buildGatewayApp({ logger: false, clock });
    const gatewayUrl = await gatewaySim.listen({ port: 0, host: "127.0.0.1" });
    gatewayClient = createGatewayClient({ baseUrl: gatewayUrl });
    agentSim = await buildAgentApp({ logger: false, clock });
    const agentUrl = await agentSim.listen({ port: 0, host: "127.0.0.1" });
    agentClient = createAgentClient({ baseUrl: agentUrl });
    app = await buildApp({ logger: false, gateway: gatewayClient });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    clock.reset();
    agentWorkers = [];
    otherStoppers = [];
    await gatewaySim.inject({ method: "POST", url: "/_sim/reset" });
    await agentSim.inject({ method: "POST", url: "/_sim/reset" });
    // 202 立刻回、事件立刻推：先后顺序由各 worker 什么时候处理决定，不由模拟器的随机延迟决定
    await gatewayScenario({ send: { acceptDelayMs: 0, eventDelayMs: 0 } });
    // 游标从 0 起：入站 worker 带 since 连流，模拟器 reset 后事件号也从 1 起
    await advanceCursor(0, { clock });
    admin = await loginAs(app, "admin");
  });

  afterEach(async () => {
    for (const w of agentWorkers) await w.stop();
    await Promise.all(otherStoppers.map((stop) => stop()));
  });

  afterAll(async () => {
    await app.close();
    await agentSim.close();
    await gatewaySim.close();
    await closeDb();
  });

  // ---- 模拟器控制面 ------------------------------------------------------------------------

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

  /** 网关里由我方发出（带 clientMsgId）的消息 —— 「网关恰好一条」看它 */
  const ownAtGateway = async () =>
    (await gatewayState()).messages.filter((m) => m.clientMsgId !== null);

  async function connectAtGateway(accountId: string): Promise<string> {
    const res = await gatewaySim.inject({
      method: "POST",
      url: `/accounts/${accountId}/connect`,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ platformUserId: string }>().platformUserId;
  }

  /** 布景：在线群主（本地 + 网关）建群（本地 + 网关），本地成员表写群主；agentEnabled */
  async function stageGroup(): Promise<{ group: Group; creator: Account }> {
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
      agentEnabled: true,
      autoKickEnabled: false,
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

  /** 外部用户在网关里往群发一条消息：模拟器推 message 事件，由入站 worker 经 SSE 消费 */
  async function pushExternal(
    group: Group,
    text: string,
    sender = "u-ext-1",
  ): Promise<void> {
    const res = await gatewaySim.inject({
      method: "POST",
      url: "/_sim/push",
      payload: {
        kind: "message",
        groupId: group.gatewayGroupId,
        senderPlatformUserId: sender,
        text,
      },
    });
    expect(res.statusCode).toBe(200);
  }

  // ---- worker（与 src/main.ts 同一套接法，只是间隔更短、日志静默）------------------------------

  function startInbound(): void {
    const w = startInboundWorker({
      clock,
      gateway: gatewayClient,
      applyGatewayDelivery,
      log: silent,
      // 断流退避不真等 1s+：测试里最多等一个间隔
      sleep: (ms, signal) =>
        abortableSleep(Math.min(ms, WORKER_INTERVAL_MS), signal),
    });
    otherStoppers.push(() => w.stop());
  }

  function startOutbox(): void {
    const w = startOutboxWorker({
      clock,
      gateway: gatewayClient,
      workerId: `outbox-${randomUUID().slice(0, 6)}`,
      intervalMs: WORKER_INTERVAL_MS,
      log: silent,
    });
    otherStoppers.push(() => w.stop());
  }

  type AgentHooks = {
    workerId?: string;
    checkpoint?: (point: Checkpoint) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  };

  function startAgent(hooks: AgentHooks = {}): AgentWorkerHandle {
    const w = startAgentWorker({
      clock,
      agent: agentClient,
      gateway: gatewayClient,
      workerId: hooks.workerId ?? `agent-${randomUUID().slice(0, 6)}`,
      intervalMs: WORKER_INTERVAL_MS,
      log: silent,
      turnTimeoutMs: 5_000,
      auditTimeoutMs: 2_000,
      ...(hooks.sleep ? { sleep: hooks.sleep } : {}),
      ...(hooks.checkpoint ? { checkpoint: hooks.checkpoint } : {}),
    });
    agentWorkers.push(w);
    return w;
  }

  /** 三个 worker 一起起（默认）；agent 可带钩子 */
  function startAll(hooks: AgentHooks = {}): AgentWorkerHandle {
    startInbound();
    startOutbox();
    return startAgent(hooks);
  }

  const tick = (
    workerId: string,
    maxStepsPerTick: number,
    checkpoint?: (point: Checkpoint) => Promise<void>,
  ) =>
    runAgentTick({
      clock,
      agent: agentClient,
      gateway: gatewayClient,
      workerId,
      log: silent,
      turnTimeoutMs: 5_000,
      auditTimeoutMs: 2_000,
      sleep: realSleep,
      maxStepsPerTick,
      ...(checkpoint ? { checkpoint } : {}),
    });

  // ---- 库 ----------------------------------------------------------------------------------

  const runsOf = (group: Group) =>
    getDb().agentRun.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
  const run = (id: string) =>
    getDb().agentRun.findUniqueOrThrow({ where: { id } });
  const steps = (runId: string) =>
    getDb().agentStep.findMany({ where: { runId }, orderBy: { index: "asc" } });
  const parseContent = (s: string | null): Json =>
    JSON.parse(s ?? "null") as Json;

  /** 等该群出现第 n 个 run（触发经 SSE → ingest 自动发生，不是测试直接建的） */
  async function waitForRun(group: Group, nth = 1): Promise<AgentRun> {
    await waitFor(
      async () => (await runsOf(group)).length >= nth,
      `群 ${group.id} 的第 ${nth} 个 run 被创建`,
    );
    return (await runsOf(group))[nth - 1]!;
  }

  async function waitForEnded(runId: string): Promise<AgentRun> {
    await waitFor(
      async () => (await run(runId)).status !== "running",
      `run ${runId} 结束`,
      CASE_TIMEOUT_MS - 2_000,
    );
    return run(runId);
  }

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

  // ---- S5 ------------------------------------------------------------------------------------

  it(
    "S5 幂等发送：网关 504、1.5s 后落地；同 key 再调 → 网关恰好一条、第二次 tool_result 是 sent、审计一次、run finished/final",
    async () => {
      // 摘掉什么就红：executeSend 的幂等命中分支（同 run 同 key 已入队 → 不发不审）→ 网关两条、audits 2；
      // outbox 的「unknown 确认前不重发」→ sendCalls 2；入站 applyGatewayDelivery（message_sent → sent）与
      // resolveUnknown 都摘 → 第一次 tool_result 停在 unknown / SEND_TIMEOUT。
      const { group, creator } = await stageGroup();
      await gatewayScenario({
        send: { responses: [{ status: 504, landAfterMs: S5_LAND_AFTER_MS }] },
      });
      await agentScenario({
        turn: {
          steps: [
            { type: "get_recent_messages", limit: 10 },
            { type: "send_message", text: "S5 回复" },
            { type: "send_message", reuse_key: true },
          ],
        },
      });
      startAll();

      await pushExternal(group, "有人吗");
      const created = await waitForRun(group);
      expect(created.triggerMessages).toEqual([
        expect.objectContaining({
          text: "有人吗",
          senderPlatformUserId: "u-ext-1",
        }),
      ]);
      const done = await waitForEnded(created.id);
      expectEnded(done, "finished", "final");
      expect(done.stepCount).toBe(4);

      // 步骤：get_recent → send（504 → unknown → 1.5s 落地 → sent）→ 同 key 再调（幂等命中）→ finish
      const s = await steps(created.id);
      expect(s.map((x) => [x.index, x.kind, x.name, x.isError])).toEqual([
        [1, "tool_use", "get_recent_messages", false],
        [2, "tool_use", "send_message", false],
        [3, "tool_use", "send_message", false],
        [4, "final", "finish", false],
      ]);
      const first = parseContent(s[1]?.resultContent ?? null);
      const second = parseContent(s[2]?.resultContent ?? null);
      expect(first.deliveryStatus).toBe("sent");
      expect(second).toEqual({
        clientMsgId: first.clientMsgId,
        deliveryStatus: "sent",
      });
      expect(s[1]).toMatchObject({ auditVerdict: "pass", auditAttempts: 1 });
      expect(s[2]).toMatchObject({ auditVerdict: null, auditAttempts: 0 });
      expect(
        await getDb().agentIdempotency.count({ where: { runId: created.id } }),
      ).toBe(1);

      // 网关：send 只被调了一次（504 那次），落地恰好一条，且就是那个 clientMsgId
      const gw = await gatewayState();
      expect(gw.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
        [first.clientMsgId, 504],
      ]);
      const own = await ownAtGateway();
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({
        clientMsgId: first.clientMsgId,
        text: "S5 回复",
        senderPlatformUserId: creator.platformUserId,
      });
      // 库里的出站行：sent、msgId 是网关落地的那条；回流的 message 事件合并进它，没有第二行
      const row = await getDb().message.findUniqueOrThrow({
        where: { clientMsgId: first.clientMsgId as string },
      });
      expect(row).toMatchObject({
        deliveryStatus: "sent",
        msgId: own[0]!.msgId,
        isOwn: true,
      });
      expect(
        await getDb().message.count({ where: { groupId: group.id } }),
      ).toBe(2);

      // Agent 模拟器：审计恰好一次；第 4 轮请求里，第 3 步（同 key）的 tool_result 内容就是 sent
      const sim = await agentState();
      expect(sim.audits).toHaveLength(1);
      expect(sim.audits[0]).toMatchObject({
        groupId: group.gatewayGroupId,
        text: "S5 回复",
      });
      const session = sim.runs.find((x) => x.runId === created.id)!;
      expect(session.turns).toBe(4);
      expect(new Set(session.sendKeys).size).toBe(1);
      const fourth = session.requests[3]!.messages;
      const lastBlock = fourth[fourth.length - 1]!.content[0] as {
        type: string;
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      };
      expect(lastBlock).toMatchObject({
        type: "tool_result",
        tool_use_id: s[2]?.toolUseId,
      });
      expect(lastBlock.is_error ?? false).toBe(false);
      expect(JSON.parse(lastBlock.content)).toEqual({
        clientMsgId: first.clientMsgId,
        deliveryStatus: "sent",
      });
    },
    CASE_TIMEOUT_MS,
  );

  // ---- S6 ------------------------------------------------------------------------------------

  it(
    "S6 协议错误：坏 JSON → 未知工具 → 正常结束；每步有 kind 与 rawResponse；worker 不崩，下一个 run 照常",
    async () => {
      // 摘掉什么就红：parseTurnBody 对非 JSON 的 BAD_JSON 分支（抛出去 → tick 异常、run 卡在 running）；
      // validateToolCall 的 UNKNOWN_TOOL（当协议错误 → 第 2 步 kind 变 protocol_error）；createToolStep 写
      // rawResponse → rawResponse 为 null。
      const { group } = await stageGroup();
      await agentScenario({
        turn: { steps: [{ type: "invalid_json" }, { type: "unknown_tool" }] },
      });
      startAll();

      await pushExternal(group, "S6");
      const created = await waitForRun(group);
      const done = await waitForEnded(created.id);
      expect(["final", "budget_exhausted", "protocol_errors"]).toContain(
        done.endReason,
      );
      expectEnded(done, "finished", "final");
      const s = await steps(created.id);
      expect(s.map((x) => [x.kind, x.errorCode, x.isError])).toEqual([
        ["protocol_error", "BAD_JSON", true],
        ["tool_use", "UNKNOWN_TOOL", true],
        ["final", null, false],
      ]);
      for (const step of s) {
        expect(step.kind).toBeTruthy();
        expect(typeof step.rawResponse).toBe("string");
        expect(step.rawResponse!.length).toBeGreaterThan(0);
        expect(step.completedAt).not.toBeNull();
      }
      expect(s[0]?.resultContent).toMatch(/^PROTOCOL_ERROR BAD_JSON: /);
      expect((await gatewayState()).sendCalls).toHaveLength(0);

      // 服务不崩：HTTP 还在、同一批 worker 继续工作 —— 换回默认剧本再来一条外部消息，第二个 run 完整跑完并真的发出一条
      expect(
        (await app.inject({ method: "GET", url: "/api/health" })).statusCode,
      ).toBe(200);
      await agentScenario({ turn: { steps: [] } });
      await pushExternal(group, "还在吗", "u-ext-2");
      const next = await waitForRun(group, 2);
      expect(next.id).not.toBe(created.id);
      expectEnded(await waitForEnded(next.id), "finished", "final");
      expect((await steps(next.id)).map((x) => x.name)).toEqual(["finish"]);
      const detail = await app.inject({
        method: "GET",
        url: `/api/agent-runs/${created.id}`,
        headers: admin,
      });
      expect(detail.statusCode).toBe(200);
      const body = detail.json<{ steps: Json[] }>();
      expect(body.steps.map((x) => x.kind)).toEqual([
        "protocol_error",
        "tool_use",
        "final",
      ]);
      expect(body.steps.every((x) => typeof x.rawResponse === "string")).toBe(
        true,
      );
    },
    CASE_TIMEOUT_MS,
  );

  // ---- 触发链路（A5 第 1 条 / S2 / S3 的 agent 侧）-----------------------------------------------

  it(
    "触发：外部消息经 SSE → ingest 自动建 run；自己的消息回流不触发；run 期间第二条 → pending → 下一次 run 的 trigger",
    async () => {
      // 摘掉什么就红：ingest 里对非自己消息调 onInboundMessage → 没有 run（第一个 waitForRun 超时）；
      // onInboundMessage 的 isOwn 过滤（或 ingest 按 platformUserId 反查服务账号）→ 回流后多出第 3 个 run；
      // 「有 running 就记 pending」/ endRun 合并 pending → 第 2 个 run 不出现或 trigger 不含第二条。
      const { group, creator } = await stageGroup();
      const gate = makeGate();
      let gated = false;
      startAll({
        // 第一个 run 的第一轮 turn 之前停在门上：这段时间 run 是 running，此时到达的消息应记为 pending
        checkpoint: async (point) => {
          if (point === "before_turn" && !gated) {
            gated = true;
            await gate.wait;
          }
        },
      });

      await pushExternal(group, "第一条", "u-a");
      const first = await waitForRun(group);
      expect(first.status).toBe("running");
      expect(first.triggerMessages).toEqual([
        expect.objectContaining({
          text: "第一条",
          senderPlatformUserId: "u-a",
        }),
      ]);
      await waitFor(
        async () => gated,
        "agent worker 领到 run 并停在 turn 之前",
      );

      // run 期间第二条外部消息 → pending，不建第二个 run
      await pushExternal(group, "第二条", "u-b");
      await waitFor(
        async () =>
          (await getDb().agentPendingMessage.count({
            where: { runId: first.id },
          })) === 1,
        "第二条记为 pending",
      );
      expect(await runsOf(group)).toHaveLength(1);

      // 放行：默认剧本 get_recent → send → finish；自己发出的那条经网关回流（message 事件）不触发
      gate.open();
      expectEnded(await waitForEnded(first.id), "finished", "final");
      const second = await waitForRun(group, 2);
      expect(second.triggerMessages).toEqual([
        expect.objectContaining({
          text: "第二条",
          senderPlatformUserId: "u-b",
        }),
      ]);
      expectEnded(await waitForEnded(second.id), "finished", "final");
      // 两个 run 各发了一条，回流各一次；等回流都记账成 sent，确认没有第 3 个 run
      await waitFor(
        async () =>
          (await getDb().message.count({
            where: { groupId: group.id, isOwn: true, deliveryStatus: "sent" },
          })) === 2,
        "两条自己的消息回流并记账为 sent",
      );
      await realSleep(WORKER_INTERVAL_MS * 3);
      expect(await runsOf(group)).toHaveLength(2);
      // pending 记录留着（记的是「曾在哪个 run 期间到达」），但只挂在第一个 run 上、回流没有新增
      expect(await getDb().agentPendingMessage.count()).toBe(1);
      expect(
        await getDb().agentPendingMessage.count({
          where: { runId: second.id },
        }),
      ).toBe(0);
      const own = await ownAtGateway();
      expect(own).toHaveLength(2);
      expect(
        own.every((m) => m.senderPlatformUserId === creator.platformUserId),
      ).toBe(true);
      // 时间线：两条外部 + 两条自己的，回流没有产生第 5 行
      expect(
        await getDb().message.count({ where: { groupId: group.id } }),
      ).toBe(4);
      const gw = await gatewayState();
      expect(gw.events.byType).toMatchObject({ message: 4, message_sent: 2 });
    },
    CASE_TIMEOUT_MS,
  );

  // ---- 重启恢复（A5 第 8 条）---------------------------------------------------------------------

  describe("重启恢复（真 startAgentWorker，在缝上 stop）", () => {
    /** 在指定的缝上「死掉」：stop() 让循环不再开始下一步，同时抛错让本步中断 → tick 释放 run → 循环退出 */
    function crashAt(point: Checkpoint): {
      dead: () => Promise<void>;
      worker: () => AgentWorkerHandle;
    } {
      let handle: AgentWorkerHandle | undefined;
      let stopping: Promise<void> | undefined;
      const hooks: AgentHooks = {
        workerId: "w-dead",
        checkpoint: async (p) => {
          if (p === point && !stopping) {
            stopping = handle!.stop();
            throw new Error(`simulated crash at ${point}`);
          }
        },
      };
      return {
        worker: () => {
          handle = startAll(hooks);
          return handle;
        },
        dead: async () => {
          await waitFor(async () => stopping !== undefined, `到达缝 ${point}`);
          await stopping;
        },
      };
    }

    it(
      "send 已入队、结果未记时死掉：新 worker 只等结果 → 网关恰好一条、不再审计、步骤不重复、run finished",
      async () => {
        // 摘掉什么就红：executeSend 的「toolStartedAt 非空 → 用 agent_idempotency 的 clientMsgId 只等结果」
        // （重新入队 → 网关两条、sendCalls 2）；runStep 的「续未完成的步」（新 worker 再 turn 一次 → 步骤 3 条、
        // agent 模拟器 turns 3）；入队与幂等记录同一事务（死在两者之间 → 幂等表空、重发）。
        const { group } = await stageGroup();
        await agentScenario({
          turn: { steps: [{ type: "send_message", text: "恢复" }] },
        });
        const crash = crashAt("after_enqueue");
        crash.worker();
        await pushExternal(group, "在吗");
        const created = await waitForRun(group);
        await crash.dead();

        // 死后库里的中间态：一步已入队未记结果、幂等记录一条、run 已释放但仍 running
        let s = await steps(created.id);
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({
          name: "send_message",
          auditVerdict: "pass",
          completedAt: null,
        });
        expect(s[0]?.toolStartedAt).not.toBeNull();
        const idem = await getDb().agentIdempotency.findMany({
          where: { runId: created.id },
        });
        expect(idem).toHaveLength(1);
        const mid = await run(created.id);
        expect(mid.status).toBe("running");
        expect(mid.claimedBy).toBeNull();

        // 新 worker 接手跑完
        startAgent({ workerId: "w-new" });
        const done = await waitForEnded(created.id);
        expectEnded(done, "finished", "final");
        s = await steps(created.id);
        expect(s.map((x) => [x.index, x.name, x.isError])).toEqual([
          [1, "send_message", false],
          [2, "finish", false],
        ]);
        expect(s[0]).toMatchObject({ auditAttempts: 1 });
        const content = parseContent(s[0]?.resultContent ?? null);
        expect(content.clientMsgId).toBe(idem[0]?.clientMsgId);
        expect(["accepted", "sent"]).toContain(content.deliveryStatus);
        await waitFor(
          async () => (await ownAtGateway()).length === 1,
          "网关落地",
        );
        const gw = await gatewayState();
        expect(gw.sendCalls.map((c) => [c.clientMsgId, c.status])).toEqual([
          [idem[0]?.clientMsgId, 202],
        ]);
        expect(await ownAtGateway()).toHaveLength(1);
        const sim = await agentState();
        expect(sim.audits).toHaveLength(1);
        expect(sim.runs.find((x) => x.runId === created.id)?.turns).toBe(2);
        expect(
          await getDb().agentIdempotency.count({
            where: { runId: created.id },
          }),
        ).toBe(1);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "审计已通过、入队之前死掉：新 worker 不再审计，直接入队 → 审计一次、网关恰好一条",
      async () => {
        // 摘掉什么就红：executeSend 的「step.auditVerdict 已是 pass 就跳过审计」→ audits 2；审计结论先落库再
        // 往下走（runAudit 写 auditVerdict）→ 死后 auditVerdict 为 null。
        const { group } = await stageGroup();
        await agentScenario({
          turn: { steps: [{ type: "send_message", text: "审后死" }] },
        });
        const crash = crashAt("after_audit");
        crash.worker();
        await pushExternal(group, "在吗");
        const created = await waitForRun(group);
        await crash.dead();

        let s = await steps(created.id);
        expect(s).toHaveLength(1);
        expect(s[0]).toMatchObject({
          name: "send_message",
          auditVerdict: "pass",
          auditAttempts: 1,
          toolStartedAt: null,
          completedAt: null,
        });
        expect(await getDb().agentIdempotency.count()).toBe(0);
        expect((await gatewayState()).sendCalls).toHaveLength(0);

        startAgent({ workerId: "w-new" });
        expectEnded(await waitForEnded(created.id), "finished", "final");
        s = await steps(created.id);
        expect(s.map((x) => [x.index, x.name, x.isError])).toEqual([
          [1, "send_message", false],
          [2, "finish", false],
        ]);
        expect(s[0]).toMatchObject({ auditVerdict: "pass", auditAttempts: 1 });
        await waitFor(
          async () => (await ownAtGateway()).length === 1,
          "网关落地",
        );
        expect((await gatewayState()).sendCalls).toHaveLength(1);
        expect((await agentState()).audits).toHaveLength(1);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "优雅停机：等发送结果时 stop() → 在途的步做完才返回、run 释放；新 worker 续跑 → 网关恰好一条",
      async () => {
        // 摘掉什么就红：startAgentWorker.stop 等 loop（不等 → stop 返回时步还没记账，下面 completedAt 断言红）；
        // releaseRun 把 claimedBy 置空（不置 → 新 worker 领不到，waitForEnded 超时）。
        const { group } = await stageGroup();
        await agentScenario({
          turn: { steps: [{ type: "send_message", text: "停机" }] },
        });
        let stopping: Promise<void> | undefined;
        const w1 = startAll({
          workerId: "w-stop",
          // 第一次进入等待（send 已入队、还在等 accepted / sent）就发起停机；等待本身照常
          sleep: async (ms) => {
            stopping ??= w1.stop();
            await realSleep(ms);
          },
        });
        await pushExternal(group, "在吗");
        const created = await waitForRun(group);
        await waitFor(async () => stopping !== undefined, "进入发送等待");
        await stopping;

        // stop 返回时：这一步已经记了结果，run 还 running 但已释放，活跃时长折进 accumulatedMs
        const mid = await run(created.id);
        expect(mid.status).toBe("running");
        expect(mid.claimedBy).toBeNull();
        expect(mid.activeSince).toBeNull();
        expect(mid.stepCount).toBe(1);
        let s = await steps(created.id);
        expect(s).toHaveLength(1);
        expect(s[0]?.completedAt).not.toBeNull();
        expect(["accepted", "sent"]).toContain(
          parseContent(s[0]?.resultContent ?? null).deliveryStatus,
        );

        startAgent({ workerId: "w-new" });
        expectEnded(await waitForEnded(created.id), "finished", "final");
        s = await steps(created.id);
        expect(s.map((x) => [x.index, x.name])).toEqual([
          [1, "send_message"],
          [2, "finish"],
        ]);
        await waitFor(
          async () => (await ownAtGateway()).length === 1,
          "网关落地",
        );
        expect((await gatewayState()).sendCalls).toHaveLength(1);
        expect((await agentState()).audits).toHaveLength(1);
      },
      CASE_TIMEOUT_MS,
    );
  });

  // ---- 多副本并发 --------------------------------------------------------------------------

  it(
    "并发：两条外部消息同时触发同群 → 恰好一个 running；两个 runAgentTick 同时领 → 恰好一个领到；交替执行步骤不重复",
    async () => {
      // 摘掉什么就红：agent_runs 的部分唯一索引 / INSERT … ON CONFLICT → 两个 running；claimRun 的
      // claimed_by IS NULL 条件（或 FOR UPDATE SKIP LOCKED 改成无锁 SELECT）→ 两个 tick 都返回 runId、同一步被
      // 两个副本各跑一遍（步骤 index 重复 / agent 模拟器 turns 多于步数）。
      const { group } = await stageGroup();
      // 只起 outbox（send 要它变 accepted）；触发用 ingest 直接并发两条事件，agent 用两个 runAgentTick 手动交替
      startOutbox();
      const ingestExternal = (eventId: number, msgId: string, text: string) =>
        ingest(
          {
            eventId,
            type: "message",
            data: {
              groupId: group.gatewayGroupId,
              msgId,
              senderPlatformUserId: `u-${msgId}`,
              text,
              sentAt: clock.now().toISOString(),
            },
          },
          { clock, log: silent, applyGatewayDelivery },
        );
      const [r1, r2] = await Promise.all([
        ingestExternal(1, "c-1", "并发一"),
        ingestExternal(2, "c-2", "并发二"),
      ]);
      expect([r1.outcome, r2.outcome]).toEqual(["processed", "processed"]);
      const runs = await runsOf(group);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("running");
      expect(await getDb().agentPendingMessage.count()).toBe(1);
      const first = runs[0]!;

      // 两个副本同时领：恰好一个拿到 run 并跑了一步，另一个空手（SKIP LOCKED / claimed_by 条件）
      const [a, b] = await Promise.all([tick("w-a", 1), tick("w-b", 1)]);
      const got = [a, b].filter((x) => x !== null);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ runId: first.id, steps: 1 });
      expect((await run(first.id)).claimedBy).toBeNull();
      expect(await steps(first.id)).toHaveLength(1);

      // 一个副本领着、正在跑一步（停在 turn 之前）：另一个副本此时来领 → 空手，不能把 run 抢走
      // （SKIP LOCKED 只挡「同一瞬间」；这里领取事务早已提交，靠的是 claimed_by IS NULL / 心跳未过期）
      const gate = makeGate();
      let holding = false;
      const held = tick("w-a", 1, async (p) => {
        if (p === "before_turn" && !holding) {
          holding = true;
          await gate.wait;
        }
      });
      await waitFor(async () => holding, "w-a 领到并停在 turn 之前");
      expect((await run(first.id)).claimedBy).toBe("w-a");
      expect(await tick("w-b", 1)).toBeNull();
      gate.open();
      expect(await held).toMatchObject({ runId: first.id, steps: 1 });
      expect(await steps(first.id)).toHaveLength(2);

      // 之后 a / b 交替各跑一步直到终态：步骤 index 连续不重复、每步只被执行一次
      let last: Awaited<ReturnType<typeof tick>> = got[0]!;
      for (let i = 0; i < 20 && last?.outcome !== "ended"; i += 1) {
        last = await tick(i % 2 === 0 ? "w-b" : "w-a", 1);
        expect(last).not.toBeNull();
      }
      expect(last?.outcome).toBe("ended");
      const done = await run(first.id);
      expectEnded(done, "finished", "final");
      const s = await steps(first.id);
      expect(s.map((x) => x.index)).toEqual([1, 2, 3]);
      expect(s.map((x) => x.name)).toEqual([
        "get_recent_messages",
        "send_message",
        "finish",
      ]);
      expect(done.stepCount).toBe(3);
      const sim = await agentState();
      expect(sim.runs.find((x) => x.runId === first.id)?.turns).toBe(3);
      expect(sim.audits).toHaveLength(1);
      expect((await gatewayState()).sendCalls).toHaveLength(1);

      // 第一条结束时把 pending 合并成第二个 run：仍是「同群恰好一个 running」
      const after = await runsOf(group);
      expect(after).toHaveLength(2);
      expect(after.filter((r) => r.status === "running")).toHaveLength(1);
      const nextTrigger = after[1]?.triggerMessages as { msgId: string }[];
      expect(nextTrigger).toHaveLength(1);
      expect(nextTrigger[0]?.msgId).toMatch(/^c-[12]$/);
      expect(
        await getDb().agentPendingMessage.count({
          where: { runId: after[1]?.id },
        }),
      ).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
