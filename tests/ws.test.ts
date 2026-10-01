// issue #9 / #18：WS /ws（题目 2.3）—— auth 帧、事件推送、sinceSeq 补发、心跳、认证超时、停机。
// 真库 + 真端口：app.listen(0)，客户端用 Node 内置的 WebSocket（node:http 导出的就是全局那个，不装 ws）。
// hub 的轮询由 ws-broadcast-worker 驱动，间隔调到 20ms；等待一律 vi.waitFor（轮询断言），不真 sleep。
// 认证超时按注入的假时钟算：拨快时钟、等下一次 pump 关连接。
import { WebSocket } from "node:http";

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
import { ACCESS_TOKEN_TTL_SECONDS } from "../src/core/jwt.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import { emitWsEvent, type WsEventType } from "../src/services/ws-events.js";
import {
  createWsHub,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_SESSION_RECHECK_MS,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_SHUTDOWN,
  type WsHub,
} from "../src/services/ws-hub.js";
import {
  startWsBroadcastWorker,
  type WsBroadcastWorkerHandle,
} from "../src/workers/ws-broadcast-worker.js";
import {
  authHeaders,
  loginAs,
  logout,
  publishWsEvent,
  tokenFrom,
} from "./factories.js";
import { truncateAll } from "./setup.js";

type Frame = Record<string, unknown>;
type EventFrame = { seq: number; type: string; payload: unknown };

/** 补发上限调小，resync 用例才造得出「落后超过上限」 */
const MAX_REPLAY = 5;
const POLL_MS = 20;

function fakeClock(
  start = new Date(),
): Clock & { advance(ms: number): void; reset(): void } {
  let now = start.getTime();
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

/** 测试客户端：收到的帧按序攒着，关闭事件记 code */
type Client = {
  ws: WebSocket;
  frames: Frame[];
  events(): EventFrame[];
  closed: { code: number; reason: string } | null;
  send(frame: Frame): void;
  close(): Promise<void>;
};

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  const client: Client = {
    ws,
    frames: [],
    // 事件帧：带 seq、且不是控制帧（auth 成功帧也带 seq —— 那是补发点，不是事件）
    events: () =>
      client.frames.filter(
        (f): f is EventFrame =>
          typeof f.seq === "number" && f.type !== "auth" && f.type !== "resync",
      ),
    closed: null,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: async () => {
      if (client.closed) return;
      ws.close();
      await vi.waitFor(() => expect(client.closed).not.toBeNull());
    },
  };
  ws.addEventListener("message", (ev) => {
    client.frames.push(JSON.parse(String(ev.data)) as Frame);
  });
  ws.addEventListener("close", (ev) => {
    client.closed = { code: ev.code, reason: ev.reason };
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("连接失败")));
  });
  return client;
}

/** 连接 + 认证成功 */
async function connectAuthed(
  url: string,
  token: string,
  sinceSeq?: number,
): Promise<Client> {
  const client = await connect(url);
  client.send({
    type: "auth",
    accessToken: token,
    ...(sinceSeq === undefined ? {} : { sinceSeq }),
  });
  await vi.waitFor(() =>
    expect(client.frames[0]).toMatchObject({ type: "auth", success: true }),
  );
  return client;
}

async function emit(type: WsEventType, payload: Record<string, string>) {
  return publishWsEvent(type, payload);
}

describe("WS /ws", () => {
  let app: FastifyInstance;
  let hub: WsHub;
  let worker: WsBroadcastWorkerHandle;
  let clock: ReturnType<typeof fakeClock>;
  let wsUrl: string;
  let token: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    clock = fakeClock();
    hub = createWsHub({ clock, maxReplay: MAX_REPLAY });
    app = await buildApp({ logger: false, wsHub: hub });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    wsUrl = `${base.replace(/^http/, "ws")}/ws`;
    worker = startWsBroadcastWorker({
      hub,
      pollIntervalMs: POLL_MS,
      // 认证超时用例会触发一行 info，别刷到测试输出里
      log: logger.child({}, { level: "silent" }),
    });
  });

  beforeEach(async () => {
    await truncateAll();
    // hub 按注入时钟判 token 到期：每个用例从「现在」起，前面用例拨快的时钟不让新签的 token 显得已过期
    clock.reset();
    token = tokenFrom(await loginAs(app, "viewer"));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  afterAll(async () => {
    await worker.stop();
    await hub.stop();
    await app.close();
    await closeDb();
  });

  const open = async (sinceSeq?: number): Promise<Client> => {
    const c = await connectAuthed(wsUrl, token, sinceSeq);
    clients.push(c);
    return c;
  };

  // ---- auth ------------------------------------------------------------------------

  it("auth 成功：第一帧 auth 回 { type: auth, success: true, seq }（seq = 从它之后开始推，客户端的补发点），连接保持", async () => {
    const before = (await emit("job", { n: "1" })).seq;
    const c = await open();
    expect(c.frames).toEqual([{ type: "auth", success: true, seq: before }]);
    expect(c.closed).toBeNull();
    expect(hub.size).toBe(1);
  });

  it("auth 失败（伪造 / 过期 token）：回 success: false + UNAUTHORIZED 并关闭", async () => {
    const expired = tokenFrom(
      await authHeaders("u1", [], { clock: fakeClock(), ttlSeconds: -1 }),
    );
    for (const bad of ["not-a-jwt", expired]) {
      const c = await connect(wsUrl);
      c.send({ type: "auth", accessToken: bad });
      await vi.waitFor(() => expect(c.closed).not.toBeNull());
      expect(c.frames).toEqual([
        { type: "auth", success: false, code: "UNAUTHORIZED" },
      ]);
      expect(c.closed?.code).toBe(4401);
    }
    expect(hub.size).toBe(0);
  });

  it("logout 后同一 access token 不能再认证 WS（#17：会话检查与 requireUser 同一条规则）", async () => {
    expect(
      (await logout(app, { authorization: `Bearer ${token}` })).statusCode,
    ).toBe(200);
    const c = await connect(wsUrl);
    c.send({ type: "auth", accessToken: token });
    await vi.waitFor(() => expect(c.closed).not.toBeNull());
    expect(c.frames).toEqual([
      { type: "auth", success: false, code: "UNAUTHORIZED" },
    ]);
    expect(c.closed?.code).toBe(4401);
    expect(hub.size).toBe(0);
  });

  it("已建立的连接：logout 之后（会话作废）被 4401 关闭，不再收事件", async () => {
    const c = await open();
    expect(
      (await logout(app, { authorization: `Bearer ${token}` })).statusCode,
    ).toBe(200);
    clock.advance(DEFAULT_SESSION_RECHECK_MS);
    await vi.waitFor(() => expect(c.closed).not.toBeNull());
    expect(c.closed?.code).toBe(WS_CLOSE_SESSION_ENDED);
    expect(hub.size).toBe(0);
  });

  it("已建立的连接：access token 到期即 4401 关闭；到期前照常", async () => {
    const c = await open();
    clock.advance(ACCESS_TOKEN_TTL_SECONDS * 1000 - 5_000);
    await emit("message", { groupId: "g", msgId: "before-expiry" });
    await vi.waitFor(() => expect(c.events()).toHaveLength(1));
    expect(c.closed).toBeNull();
    clock.advance(5_000);
    await vi.waitFor(() => expect(c.closed).not.toBeNull());
    expect(c.closed?.code).toBe(WS_CLOSE_SESSION_ENDED);
  });

  it("第一帧不是 auth（ping / 非 JSON）：按未认证拒绝并关闭", async () => {
    for (const first of [JSON.stringify({ type: "ping" }), "garbage"]) {
      const c = await connect(wsUrl);
      c.ws.send(first);
      await vi.waitFor(() => expect(c.closed).not.toBeNull());
      expect(c.frames).toEqual([
        { type: "auth", success: false, code: "UNAUTHORIZED" },
      ]);
      expect(c.closed?.code).toBe(4401);
    }
  });

  it("auth 超时：5 秒没收到 auth 帧就关闭（按注入时钟）", async () => {
    const c = await connect(wsUrl);
    await vi.waitFor(() => expect(hub.size).toBe(1));
    // 未到 5 秒不关
    clock.advance(DEFAULT_AUTH_TIMEOUT_MS - 1000);
    await vi.waitFor(() => expect(hub.size).toBe(1));
    expect(c.closed).toBeNull();
    clock.advance(1000);
    await vi.waitFor(() => expect(c.closed).not.toBeNull());
    expect(c.closed?.code).toBe(WS_CLOSE_AUTH_TIMEOUT);
    expect(hub.size).toBe(0);
  });

  // ---- 推送 ------------------------------------------------------------------------

  it("事件推送：写 ws_events 后两个客户端都在 1 秒内收到、seq 单调、帧为 { seq, type, payload }", async () => {
    const a = await open();
    const b = await open();
    const rows = [
      await emit("account_status_changed", {
        accountId: "x",
        from: "idle",
        to: "online",
      }),
      await emit("message", { groupId: "g", msgId: "m1" }),
      await emit("member_changed", {
        groupId: "g",
        accountId: "x",
        change: "left",
      }),
    ];

    await vi.waitFor(
      () => {
        expect(a.events()).toHaveLength(3);
        expect(b.events()).toHaveLength(3);
      },
      { timeout: 1000 },
    );

    for (const c of [a, b]) {
      expect(c.events()).toEqual(
        rows.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload })),
      );
      const seqs = c.events().map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });

  it("晚提交的事件不被跳过：先写入的 A 晚于 B 提交 → 两条都推到、seq 按提交顺序，重连补发也都在", async () => {
    const c = await open();
    const before = c.events().length;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    // A 先写入（拿到更小的 id）但事务挂着不提交
    const txA = getDb().$transaction(
      async (tx) => {
        await emitWsEvent(tx, "message", { groupId: "g", msgId: "late" });
        markWritten();
        await gate;
      },
      { timeout: 10_000 },
    );
    await written;
    // B 后写入、先提交，推送先到；此时水位若按写入序号走，就越过了 A
    await emitWsEvent(getDb(), "message", { groupId: "g", msgId: "early" });
    await vi.waitFor(() => expect(c.events()).toHaveLength(before + 1));
    release();
    await txA;
    await vi.waitFor(() => expect(c.events()).toHaveLength(before + 2));
    const got = c.events().slice(before);
    expect(got.map((e) => (e.payload as { msgId: string }).msgId)).toEqual([
      "early",
      "late",
    ]);
    expect(got[1]!.seq).toBe(got[0]!.seq + 1);

    // 断线补发同样看得见 A
    await c.close();
    const again = await open(got[0]!.seq - 1);
    await vi.waitFor(() => expect(again.events()).toHaveLength(2));
    expect(again.events().map((e) => e.seq)).toEqual(got.map((e) => e.seq));
  });

  it("没带 sinceSeq 的连接只收认证之后的事件", async () => {
    await emit("inconsistency", { inconsistencyId: "old" });
    const c = await open();
    const fresh = await emit("agent_run", { runId: "r1", status: "running" });
    await vi.waitFor(() => expect(c.events()).toHaveLength(1));
    expect(c.events()[0]).toMatchObject({ seq: fresh.seq, type: "agent_run" });
  });

  it("重复认证帧 / 未知帧被忽略，连接不断", async () => {
    const c = await open();
    c.send({ type: "auth", accessToken: token });
    c.send({ type: "whatever" });
    c.ws.send("not json");
    c.send({ type: "ping" });
    await vi.waitFor(() => expect(c.frames).toHaveLength(2));
    expect(c.frames[1]).toEqual({ type: "pong" });
    expect(c.closed).toBeNull();
  });

  // ---- sinceSeq 补发（#18）------------------------------------------------------------

  it("sinceSeq 补发：断开 → 写 3 条 → 带 sinceSeq 重连 → 恰好收到那 3 条、顺序正确、不重复，然后进入实时", async () => {
    const first = await open();
    const seen = await emit("sequence_run", { runId: "s1", status: "running" });
    await vi.waitFor(() => expect(first.events()).toHaveLength(1));
    await first.close();

    const missed = [
      await emit("message", { groupId: "g", msgId: "m1" }),
      await emit("message", { groupId: "g", msgId: "m2" }),
      await emit("account_terminal", { accountId: "x", status: "suspended" }),
    ];

    const again = await open(seen.seq);
    await vi.waitFor(() => expect(again.events()).toHaveLength(3), {
      timeout: 3000,
    });
    expect(again.events()).toEqual(
      missed.map((r) => ({ seq: r.seq, type: r.type, payload: r.payload })),
    );
    expect(again.frames.some((f) => f.type === "resync")).toBe(false);

    // 补发完接实时：新事件继续来，seq 接着单调
    const live = await emit("message", { groupId: "g", msgId: "m3" });
    await vi.waitFor(() => expect(again.events()).toHaveLength(4));
    expect(again.events()[3]).toMatchObject({ seq: live.seq });
    const seqs = again.events().map((e) => e.seq);
    expect(new Set(seqs).size).toBe(4);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });

  it("sinceSeq 落后超过上限：先推 resync，再从 max − 上限 起补发", async () => {
    const rows: { seq: number }[] = [];
    for (let i = 0; i < MAX_REPLAY + 3; i += 1) {
      rows.push(await emit("message", { groupId: "g", msgId: `m${i}` }));
    }
    const max = rows[rows.length - 1]!.seq;
    const c = await open(0);
    await vi.waitFor(() => expect(c.events()).toHaveLength(MAX_REPLAY), {
      timeout: 3000,
    });
    expect(c.frames[1]).toEqual({
      type: "resync",
      sinceSeq: 0,
      fromSeq: max - MAX_REPLAY,
    });
    expect(c.events().map((e) => e.seq)).toEqual(
      rows.slice(-MAX_REPLAY).map((r) => r.seq),
    );
  });

  it("sinceSeq 等于当前 max：不补发、不 resync，只收之后的", async () => {
    const last = await emit("message", { groupId: "g", msgId: "m0" });
    const c = await open(last.seq);
    const next = await emit("message", { groupId: "g", msgId: "m1" });
    await vi.waitFor(() => expect(c.events()).toHaveLength(1));
    expect(c.events()[0]).toMatchObject({ seq: next.seq });
    expect(c.frames.some((f) => f.type === "resync")).toBe(false);
  });

  // ---- 心跳与停机 --------------------------------------------------------------------

  it("心跳：{ type: ping } → { type: pong }", async () => {
    const c = await open();
    c.send({ type: "ping" });
    await vi.waitFor(() => expect(c.frames[1]).toEqual({ type: "pong" }));
  });

  it("hub.stop()：所有连接以 1001 关闭；之后新连接仍能认证（worker 还在轮询）", async () => {
    const a = await open();
    const b = await open();
    await hub.stop();
    await vi.waitFor(() => {
      expect(a.closed?.code).toBe(WS_CLOSE_SHUTDOWN);
      expect(b.closed?.code).toBe(WS_CLOSE_SHUTDOWN);
    });
    expect(hub.size).toBe(0);
    const c = await open();
    expect(c.closed).toBeNull();
  });
});
