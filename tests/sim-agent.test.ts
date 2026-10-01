// Agent 服务模拟器（src/sim/agent）自带的用例：默认剧本三轮、tools 校验、每种坏行为的响应体形状、
// 按 runId 的会话状态、audit 各分支、S5 / S6 剧本。延迟用注入的假 sleep / 假时钟，不真等。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";

import type { Clock } from "../src/core/clock.js";
import { buildAgentApp } from "../src/sim/agent/app.js";

// ---- 题目规定的 4 个工具（合法形状）----
const schema = (
  props: Record<string, { type: string }>,
): Record<string, unknown> => ({
  type: "object",
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "get_recent_messages",
    description: "取最近的消息",
    input_schema: schema({ limit: { type: "number" } }),
  },
  {
    name: "send_message",
    description: "发一条消息",
    input_schema: schema({
      text: { type: "string" },
      idempotency_key: { type: "string" },
    }),
  },
  {
    name: "kick_user",
    description: "移除成员",
    input_schema: schema({
      platform_user_id: { type: "string" },
      reason: { type: "string" },
    }),
  },
  {
    name: "finish",
    description: "结束",
    input_schema: schema({ summary: { type: "string" } }),
  },
];

const TRIGGER = {
  role: "user",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        groupId: "g1",
        triggerMessages: [],
        policy: { autoKickEnabled: false },
        ownPlatformUserIds: [],
      }),
    },
  ],
};

// ---- 可控的假 sleep：记录每次请求的毫秒数，flush() 才放行 ----
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

function makeClock(): Clock & { advance: (ms: number) => void } {
  let now = Date.now();
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** 让出事件循环，直到条件成立（inject 的 handler 要几个宏任务才跑到 sleep / hang 处）；上限防死等 */
async function waitFor(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await cond()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor：条件一直不成立");
}

/** 断言字符串不是合法 JSON */
const notJson = (body: string) => (): void => {
  JSON.parse(body);
};

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type TurnBody = { stop_reason?: string; content: Record<string, unknown>[] };

describe("sim agent", () => {
  let app: FastifyInstance;
  const fake = makeSleep();
  const clock = makeClock();

  const turn = (
    runId: string,
    messages: unknown[] = [TRIGGER],
    tools: unknown = TOOLS,
  ) =>
    app.inject({
      method: "POST",
      url: "/agent/turn",
      payload: { runId, tools, messages },
    });

  const scenario = (payload: InjectOptions["payload"]) =>
    app.inject({ method: "POST", url: "/_sim/scenario", payload });

  const audit = (payload: InjectOptions["payload"]) =>
    app.inject({ method: "POST", url: "/agent/audit", payload });

  const state = async (runId?: string) => {
    const res = await app.inject({
      method: "GET",
      url: "/_sim/state",
      query: runId ? { runId } : {},
    });
    expect(res.statusCode).toBe(200);
    return res.json<{
      runs: {
        runId: string;
        turns: number;
        toolUseIds: string[];
        sendKeys: string[];
        pending: number;
        seenToolResults: { tool_use_id: string; name: string | null }[];
        requests: { turn: number; messages: unknown[]; responded: boolean }[];
      }[];
      audits: { seq: number; groupId: string; text: string; mode: string }[];
    }>();
  };

  const onlyBlock = (body: TurnBody): ToolUseBlock => {
    expect(body.content).toHaveLength(1);
    return body.content[0] as ToolUseBlock;
  };

  beforeAll(async () => {
    app = await buildAgentApp({ logger: false, clock, sleep: fake.sleep });
    await app.ready();
  });

  beforeEach(async () => {
    fake.flush();
    const res = await app.inject({ method: "POST", url: "/_sim/reset" });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------ 默认剧本

  it("默认剧本：get_recent_messages → send_message → finish，每轮恰好一个块", async () => {
    const r1 = await turn("run-a");
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json<TurnBody>();
    expect(b1.stop_reason).toBe("tool_use");
    expect(onlyBlock(b1)).toMatchObject({
      type: "tool_use",
      id: "tu_1",
      name: "get_recent_messages",
      input: { limit: 10 },
    });

    const r2 = await turn("run-a", [
      TRIGGER,
      { role: "assistant", content: b1.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: JSON.stringify({ messages: [], truncated: false }),
          },
        ],
      },
    ]);
    const b2 = r2.json<TurnBody>();
    expect(b2.stop_reason).toBe("tool_use");
    const send = onlyBlock(b2);
    expect(send).toMatchObject({ id: "tu_2", name: "send_message" });
    expect(typeof send.input.text).toBe("string");
    expect(send.input.idempotency_key).toBe("k-run-a-1");

    const r3 = await turn("run-a");
    const b3 = r3.json<TurnBody>();
    expect(b3.stop_reason).toBe("tool_use");
    expect(onlyBlock(b3)).toMatchObject({ id: "tu_3", name: "finish" });
    expect(typeof onlyBlock(b3).input.summary).toBe("string");

    // 第 4 轮起继续 finish（兜底），不会崩
    expect(onlyBlock((await turn("run-a")).json<TurnBody>()).name).toBe(
      "finish",
    );
  });

  it("会话按 runId 隔离：另一个 runId 从第 1 轮开始；state 记录轮次、messages 与看到的 tool_result", async () => {
    await turn("run-a");
    await turn("run-a");
    const r = await turn("run-b");
    expect(onlyBlock(r.json<TurnBody>())).toMatchObject({
      id: "tu_1",
      name: "get_recent_messages",
    });

    await turn("run-a", [
      TRIGGER,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_2", name: "send_message", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            is_error: true,
            content: JSON.stringify({ code: "SEND_TIMEOUT" }),
          },
        ],
      },
    ]);

    const s = await state("run-a");
    expect(s.runs).toHaveLength(1);
    const run = s.runs[0]!;
    expect(run.turns).toBe(3);
    expect(run.requests.map((q) => q.turn)).toEqual([1, 2, 3]);
    expect(run.requests[2]!.messages).toHaveLength(3);
    expect(run.requests.every((q) => q.responded)).toBe(true);
    expect(run.seenToolResults).toEqual([
      expect.objectContaining({
        tool_use_id: "tu_2",
        name: "send_message",
        is_error: true,
      }),
    ]);
    expect(run.sendKeys).toEqual(["k-run-a-1"]);

    const all = await state();
    expect(all.runs.map((x) => x.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("请求里带图片块（后端 #61，可能超过 1 MB 默认上限）：照常受理，剧本不受影响", async () => {
    const data = Buffer.alloc(1024 * 1024 + 100).toString("base64");
    const res = await turn("run-img", [
      {
        role: "user",
        content: [
          { type: "text", text: "{}" },
          {
            type: "image",
            msgId: "m1",
            source: { type: "base64", media_type: "image/png", data },
          },
        ],
      },
    ]);
    expect(res.statusCode).toBe(200);
  });

  it("POST /_sim/reset 清空会话与剧本", async () => {
    await scenario({
      runId: "run-a",
      turn: { steps: [{ type: "no_blocks" }] },
    });
    await turn("run-a");
    await app.inject({ method: "POST", url: "/_sim/reset" });
    expect((await state()).runs).toEqual([]);
    expect(onlyBlock((await turn("run-a")).json<TurnBody>()).name).toBe(
      "get_recent_messages",
    );
  });

  // ------------------------------------------------------------------ tools 校验

  describe("tools 校验 → 400 TOOLS_INVALID", () => {
    const expectInvalid = async (tools: unknown, issue: string) => {
      const res = await turn("run-t", [TRIGGER], tools);
      expect(res.statusCode).toBe(400);
      const body = res.json<{
        error: { code: string; requestId: string; issues: string[] };
      }>();
      expect(body.error.code).toBe("TOOLS_INVALID");
      expect(typeof body.error.requestId).toBe("string");
      expect(body.error.issues.join("\n")).toContain(issue);
      // 400 不算一轮
      expect((await state("run-t")).runs).toEqual([]);
    };

    it("不是 4 个", () => expectInvalid(TOOLS.slice(0, 3), "恰好 4 个"));
    it("不是数组", () => expectInvalid(null, "必须是数组"));
    it("名字不对", () =>
      expectInvalid(
        [...TOOLS.slice(0, 3), { ...TOOLS[3], name: "done" }],
        "name 不合法",
      ));
    it("名字重复", () =>
      expectInvalid([...TOOLS.slice(0, 3), TOOLS[0]], "name 重复"));
    it("required 没覆盖全部入参", () =>
      expectInvalid(
        [
          ...TOOLS.slice(0, 1),
          {
            ...TOOLS[1],
            input_schema: { ...TOOLS[1]!.input_schema, required: ["text"] },
          },
          ...TOOLS.slice(2),
        ],
        "required 未覆盖 idempotency_key",
      ));
    it("入参类型不对", () =>
      expectInvalid(
        [
          { ...TOOLS[0], input_schema: schema({ limit: { type: "string" } }) },
          ...TOOLS.slice(1),
        ],
        "limit.type 应为 number / integer",
      ));
    it("input_schema 不是 object schema", () =>
      expectInvalid(
        [
          {
            ...TOOLS[0],
            input_schema: { type: "array", properties: {}, required: [] },
          },
          ...TOOLS.slice(1),
        ],
        'type 必须是 "object"',
      ));
    it("缺 description", () =>
      expectInvalid(
        [
          { name: "get_recent_messages", input_schema: TOOLS[0]!.input_schema },
          ...TOOLS.slice(1),
        ],
        "description",
      ));
    it("多出入参", () =>
      expectInvalid(
        [
          ...TOOLS.slice(0, 3),
          {
            ...TOOLS[3],
            input_schema: schema({
              summary: { type: "string" },
              mood: { type: "string" },
            }),
          },
        ],
        "多出 mood",
      ));
  });

  it("请求体缺 runId / messages 形状不对 → 400 VALIDATION_ERROR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/turn",
      payload: { tools: TOOLS, messages: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  // ------------------------------------------------------------------ 坏行为

  describe("剧本：题目列出的每种坏行为", () => {
    const withScenario = async (
      steps: unknown[],
      fallback?: string,
      runId = "run-x",
    ) => {
      const res = await scenario({
        runId,
        turn: { steps, ...(fallback ? { fallback } : {}) },
      });
      expect(res.statusCode).toBe(200);
      return runId;
    };

    it("invalid_json：响应体不是合法 JSON", async () => {
      const runId = await withScenario([{ type: "invalid_json" }]);
      const res = await turn(runId);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(notJson(res.body)).toThrow();
    });

    it("markdown_fenced：围栏里是合法 JSON，整体不是", async () => {
      const runId = await withScenario([{ type: "markdown_fenced" }]);
      const res = await turn(runId);
      expect(res.body.startsWith("```json\n")).toBe(true);
      expect(res.body.trimEnd().endsWith("```")).toBe(true);
      expect(notJson(res.body)).toThrow();
      const inner = res.body.replace(/^```json\n/, "").replace(/\n```$/, "");
      expect(JSON.parse(inner)).toMatchObject({ stop_reason: "end_turn" });
    });

    it("wrapped_text：前后夹着文字", async () => {
      const runId = await withScenario([{ type: "wrapped_text" }]);
      const res = await turn(runId);
      expect(notJson(res.body)).toThrow();
      expect(res.body).toContain('"stop_reason"');
      expect(res.body.startsWith("{")).toBe(false);
      expect(res.body.endsWith("}")).toBe(false);
    });

    it("missing_stop_reason：JSON 合法但缺 stop_reason", async () => {
      const runId = await withScenario([{ type: "missing_stop_reason" }]);
      const body = (await turn(runId)).json<TurnBody>();
      expect(body).not.toHaveProperty("stop_reason");
      expect(body.content).toHaveLength(1);
    });

    it("no_blocks / two_blocks：块数 0 或 2", async () => {
      const runId = await withScenario([
        { type: "no_blocks" },
        { type: "two_blocks" },
      ]);
      const b1 = (await turn(runId)).json<TurnBody>();
      expect(b1.stop_reason).toBe("end_turn");
      expect(b1.content).toEqual([]);
      const b2 = (await turn(runId)).json<TurnBody>();
      expect(b2.stop_reason).toBe("tool_use");
      expect(b2.content).toHaveLength(2);
      expect(b2.content.map((c) => c.type)).toEqual(["text", "tool_use"]);
    });

    it("stop_reason_mismatch：end_turn 却是 tool_use 块", async () => {
      const runId = await withScenario([{ type: "stop_reason_mismatch" }]);
      const body = (await turn(runId)).json<TurnBody>();
      expect(body.stop_reason).toBe("end_turn");
      expect(onlyBlock(body).type).toBe("tool_use");
    });

    it("unknown_tool：调用不在 tools 里的工具", async () => {
      const runId = await withScenario([
        { type: "unknown_tool" },
        { type: "unknown_tool", name: "ban_everyone" },
      ]);
      expect(onlyBlock((await turn(runId)).json<TurnBody>()).name).toBe(
        "delete_group",
      );
      expect(onlyBlock((await turn(runId)).json<TurnBody>()).name).toBe(
        "ban_everyone",
      );
    });

    it("invalid_input：入参不符合 input_schema", async () => {
      const runId = await withScenario([
        { type: "invalid_input" },
        { type: "invalid_input", name: "send_message" },
      ]);
      expect(onlyBlock((await turn(runId)).json<TurnBody>())).toMatchObject({
        name: "get_recent_messages",
        input: { limit: "ten" },
      });
      const send = onlyBlock((await turn(runId)).json<TurnBody>());
      expect(send.name).toBe("send_message");
      expect(send.input).not.toHaveProperty("idempotency_key");
    });

    it("duplicate_id：同一个 tool_use.id 用两次", async () => {
      const runId = await withScenario([
        { type: "get_recent_messages" },
        { type: "duplicate_id" },
      ]);
      const first = onlyBlock((await turn(runId)).json<TurnBody>());
      const second = onlyBlock((await turn(runId)).json<TurnBody>());
      expect(second.id).toBe(first.id);
      expect((await state(runId)).runs[0]!.toolUseIds).toEqual([
        first.id,
        first.id,
      ]);
    });

    it("huge_limit：get_recent_messages { limit: 100000 }", async () => {
      const runId = await withScenario([{ type: "huge_limit" }]);
      expect(onlyBlock((await turn(runId)).json<TurnBody>())).toMatchObject({
        name: "get_recent_messages",
        input: { limit: 100000 },
      });
    });

    it("repeat：连续多次用同样入参调 get_recent_messages", async () => {
      const runId = await withScenario([
        { type: "get_recent_messages", limit: 20, repeat: 3 },
      ]);
      for (let i = 0; i < 3; i += 1) {
        expect(onlyBlock((await turn(runId)).json<TurnBody>())).toMatchObject({
          name: "get_recent_messages",
          input: { limit: 20 },
        });
      }
      expect(onlyBlock((await turn(runId)).json<TurnBody>()).name).toBe(
        "finish",
      );
    });

    it("fallback loop_tools：一直调工具不结束", async () => {
      const runId = await withScenario([], "loop_tools");
      for (let i = 0; i < 15; i += 1) {
        const body = (await turn(runId)).json<TurnBody>();
        expect(body.stop_reason).toBe("tool_use");
        expect(onlyBlock(body).name).toBe("get_recent_messages");
      }
      expect((await state(runId)).runs[0]!.turns).toBe(15);
    });

    it("fallback repeat_last：重复最后一步", async () => {
      const runId = await withScenario(
        [{ type: "unknown_tool" }],
        "repeat_last",
      );
      for (let i = 0; i < 3; i += 1) {
        expect(onlyBlock((await turn(runId)).json<TurnBody>()).name).toBe(
          "delete_group",
        );
      }
    });

    it("http_error：非 2xx", async () => {
      const runId = await withScenario([
        { type: "http_error" },
        { type: "http_error", status: 429, body: "slow down" },
      ]);
      const r1 = await turn(runId);
      expect(r1.statusCode).toBe(500);
      const r2 = await turn(runId);
      expect(r2.statusCode).toBe(429);
      expect(r2.body).toBe("slow down");
    });

    it("raw：原样返回", async () => {
      const runId = await withScenario([
        {
          type: "raw",
          body: "<html>oops</html>",
          content_type: "text/html",
          status: 502,
        },
      ]);
      const res = await turn(runId);
      expect(res.statusCode).toBe(502);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe("<html>oops</html>");
    });

    it("tool_use（generic）：任意名字 / 入参 / id / stop_reason", async () => {
      const runId = await withScenario([
        {
          type: "tool_use",
          name: "send_message",
          input: { text: "hi", idempotency_key: "k-fixed" },
          id: "tu_custom",
          stop_reason: "end_turn",
        },
      ]);
      const body = (await turn(runId)).json<TurnBody>();
      expect(body.stop_reason).toBe("end_turn");
      expect(onlyBlock(body)).toMatchObject({
        id: "tu_custom",
        name: "send_message",
        input: { text: "hi", idempotency_key: "k-fixed" },
      });
      expect((await state(runId)).runs[0]!.sendKeys).toEqual(["k-fixed"]);
    });

    it("end_turn / kick_user / finish 步骤", async () => {
      const runId = await withScenario([
        { type: "kick_user", platform_user_id: "u9", reason: "广告" },
        { type: "finish", summary: "done" },
        { type: "end_turn", text: "bye" },
      ]);
      expect(onlyBlock((await turn(runId)).json<TurnBody>())).toMatchObject({
        name: "kick_user",
        input: { platform_user_id: "u9", reason: "广告" },
      });
      expect(onlyBlock((await turn(runId)).json<TurnBody>())).toMatchObject({
        name: "finish",
        input: { summary: "done" },
      });
      const b3 = (await turn(runId)).json<TurnBody>();
      expect(b3.stop_reason).toBe("end_turn");
      expect(b3.content).toEqual([{ type: "text", text: "bye" }]);
    });

    it("delay_ms：慢响应走注入的 sleep，不真等", async () => {
      const runId = await withScenario([{ type: "finish", delay_ms: 8000 }]);
      let settled = false;
      const pending = turn(runId).then((res) => {
        settled = true;
        return res;
      });
      await waitFor(() => fake.calls.length === 1);
      expect(fake.calls.map((c) => c.ms)).toEqual([8000]);
      expect(settled).toBe(false);
      expect((await state(runId)).runs[0]).toMatchObject({
        turns: 1,
        pending: 1,
      });
      fake.flush();
      const res = await pending;
      expect(onlyBlock(res.json<TurnBody>()).name).toBe("finish");
      expect((await state(runId)).runs[0]!.pending).toBe(0);
    });

    it("默认剧本（不带 runId）对所有 run 生效", async () => {
      await scenario({ turn: { steps: [{ type: "no_blocks" }] } });
      expect((await turn("run-1")).json<TurnBody>().content).toEqual([]);
      expect((await turn("run-2")).json<TurnBody>().content).toEqual([]);
      // 专属剧本优先
      await withScenario([{ type: "huge_limit" }], undefined, "run-3");
      expect(onlyBlock((await turn("run-3")).json<TurnBody>()).input).toEqual({
        limit: 100000,
      });
    });
  });

  it("hang：永不返回，直到 app 关闭", async () => {
    const other = makeSleep();
    const hung = await buildAgentApp({ logger: false, sleep: other.sleep });
    await hung.ready();
    await hung.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload: {
        runId: "run-h",
        turn: { steps: [{ type: "finish", hang: true }] },
      },
    });
    let settled = false;
    const pending = hung
      .inject({
        method: "POST",
        url: "/agent/turn",
        payload: { runId: "run-h", tools: TOOLS, messages: [TRIGGER] },
      })
      .then(() => {
        settled = true;
      });
    const pendingCount = async (): Promise<number> => {
      const s = await hung.inject({
        method: "GET",
        url: "/_sim/state",
        query: { runId: "run-h" },
      });
      return s.json<{ runs: { pending: number }[] }>().runs[0]?.pending ?? 0;
    };
    await waitFor(async () => (await pendingCount()) === 1);
    expect(settled).toBe(false);
    expect(other.calls).toEqual([]);
    await hung.close();
    await pending;
    expect(settled).toBe(true);
  });

  // ------------------------------------------------------------------ 剧本校验

  it("剧本不合法 → 400 VALIDATION_ERROR", async () => {
    const bad = await scenario({
      runId: "run-x",
      turn: { steps: [{ type: "explode" }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const empty = await scenario({ runId: "run-x" });
    expect(empty.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------ S5 / S6

  it("S5：拿到 send_message 结果后用同一个 idempotency_key 再调", async () => {
    await scenario({
      runId: "run-s5",
      turn: {
        steps: [
          { type: "send_message", text: "hello" },
          { type: "send_message", reuse_key: true },
        ],
      },
    });
    const first = onlyBlock((await turn("run-s5")).json<TurnBody>());
    const second = onlyBlock(
      (
        await turn("run-s5", [
          TRIGGER,
          { role: "assistant", content: [first] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: first.id,
                is_error: true,
                content: JSON.stringify({ code: "SEND_TIMEOUT" }),
              },
            ],
          },
        ])
      ).json<TurnBody>(),
    );
    expect(second.name).toBe("send_message");
    expect(second.id).not.toBe(first.id);
    expect(second.input.idempotency_key).toBe(first.input.idempotency_key);
    expect(onlyBlock((await turn("run-s5")).json<TurnBody>()).name).toBe(
      "finish",
    );
    const run = (await state("run-s5")).runs[0]!;
    expect(run.sendKeys).toEqual([
      first.input.idempotency_key,
      first.input.idempotency_key,
    ]);
    expect(run.seenToolResults[0]).toMatchObject({
      tool_use_id: first.id,
      name: "send_message",
      is_error: true,
    });
  });

  it("S6：坏 JSON → 未知工具 → 正常结束", async () => {
    await scenario({
      runId: "run-s6",
      turn: { steps: [{ type: "invalid_json" }, { type: "unknown_tool" }] },
    });
    const r1 = await turn("run-s6");
    expect(notJson(r1.body)).toThrow();
    const r2 = onlyBlock((await turn("run-s6")).json<TurnBody>());
    expect(r2.name).toBe("delete_group");
    const r3 = (await turn("run-s6")).json<TurnBody>();
    expect(r3.stop_reason).toBe("tool_use");
    expect(onlyBlock(r3).name).toBe("finish");
  });

  // ------------------------------------------------------------------ audit

  describe("POST /agent/audit", () => {
    it("默认 pass，并记录到 state", async () => {
      const res = await audit({ text: "你好", groupId: "g1" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ verdict: "pass" });
      expect(typeof res.json<{ reason: string }>().reason).toBe("string");
      const s = await state();
      expect(s.audits).toEqual([
        expect.objectContaining({
          seq: 1,
          groupId: "g1",
          text: "你好",
          mode: "pass",
        }),
      ]);
    });

    it("缺 text → 400 VALIDATION_ERROR", async () => {
      const res = await audit({ groupId: "g1" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });

    it("fail / http_500 / invalid_json / no_verdict / other_verdict 按序消费，用完走 fallback", async () => {
      const set = await scenario({
        groupId: "g2",
        audit: {
          steps: [
            { mode: "fail", reason: "含广告" },
            { mode: "http_500" },
            { mode: "http_500", status: 503 },
            { mode: "invalid_json" },
            { mode: "no_verdict" },
            { mode: "other_verdict", verdict: "unsure" },
          ],
          fallback: { mode: "pass" },
        },
      });
      expect(set.statusCode).toBe(200);
      const call = () => audit({ text: "t", groupId: "g2" });

      const fail = await call();
      expect(fail.statusCode).toBe(200);
      expect(fail.json()).toEqual({ verdict: "fail", reason: "含广告" });

      expect((await call()).statusCode).toBe(500);
      expect((await call()).statusCode).toBe(503);

      const bad = await call();
      expect(bad.statusCode).toBe(200);
      expect(notJson(bad.body)).toThrow();

      const noVerdict = await call();
      expect(noVerdict.statusCode).toBe(200);
      expect(noVerdict.json()).not.toHaveProperty("verdict");

      expect((await call()).json()).toMatchObject({ verdict: "unsure" });

      // 用完 → fallback pass；别的 group 不受影响（默认剧本）
      expect((await call()).json()).toMatchObject({ verdict: "pass" });
      expect((await audit({ text: "t", groupId: "g9" })).json()).toMatchObject({
        verdict: "pass",
      });
      expect((await state()).audits.map((a) => a.mode)).toEqual([
        "fail",
        "http_500",
        "http_500",
        "invalid_json",
        "no_verdict",
        "other_verdict",
        "pass",
        "pass",
      ]);
    });

    it("默认 audit 剧本（不带 groupId）：各 group 共用一条序列", async () => {
      await scenario({
        audit: { steps: [{ mode: "http_500", repeat: 2 }] },
      });
      expect((await audit({ text: "a", groupId: "g1" })).statusCode).toBe(500);
      expect((await audit({ text: "b", groupId: "g2" })).statusCode).toBe(500);
      expect((await audit({ text: "c", groupId: "g1" })).json()).toMatchObject({
        verdict: "pass",
      });
    });

    it("delay_ms：慢审计走注入的 sleep", async () => {
      await scenario({
        groupId: "g3",
        audit: { steps: [{ mode: "pass", delay_ms: 12000 }] },
      });
      let settled = false;
      const pending = audit({ text: "t", groupId: "g3" }).then((res) => {
        settled = true;
        return res;
      });
      await waitFor(() => fake.calls.length === 1);
      expect(fake.calls.map((c) => c.ms)).toEqual([12000]);
      expect(settled).toBe(false);
      fake.flush();
      expect((await pending).json()).toMatchObject({ verdict: "pass" });
    });

    it("hang：审计永不返回，直到 app 关闭", async () => {
      const hung = await buildAgentApp({ logger: false });
      await hung.ready();
      await hung.inject({
        method: "POST",
        url: "/_sim/scenario",
        payload: { audit: { steps: [{ mode: "pass", hang: true }] } },
      });
      let settled = false;
      const pending = hung
        .inject({
          method: "POST",
          url: "/agent/audit",
          payload: { text: "t", groupId: "g1" },
        })
        .then(() => {
          settled = true;
        });
      await waitFor(async () => {
        const s = await hung.inject({ method: "GET", url: "/_sim/state" });
        return s.json<{ audits: unknown[] }>().audits.length === 1;
      });
      expect(settled).toBe(false);
      await hung.close();
      await pending;
      expect(settled).toBe(true);
    });
  });

  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok" });
  });
});
