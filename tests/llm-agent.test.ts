// 题目 C2（issue #21）：真实 LLM 版 Agent 服务（src/llm-agent），上游只有 Claude 与 Gemini（官方 SDK）。
// 上游是假服务（tests/fake-anthropic.ts、tests/fake-gemini.ts，listen(0)，按剧本返回、记录请求），不打外网。
// 上游配置只来自控制台保存的配置文件：每组用例在临时目录里放一份（store.save），会话状态目录也在那里，用完删掉。
// 五部分：
// 1. Claude /agent/turn：tools / messages 直通与系统提示、思考块按 runId 回传（含重启后、记不到时的规则）、
//    tool_use / end_turn / refusal 映射、多个 tool_use 只取第一个、上游 401 / 5xx / 超时 → 502；/agent/audit。
// 2. Gemini 对应的一套（functionDeclarations / contents、thoughtSignature 回传与占位、finishReason 映射、结构化输出）。
// 3. 请求校验与未配置。
// 4. 管理端点 /admin/*：令牌、服务商切换不沿用 key、文件 600、模型列表、测试连接、key 明文不进响应与日志。
// 5. 全链路：后端 agent run（真库 + 网关模拟器 + runAgentTick）→ llm-agent → 假 Anthropic，run finished / final。
import { randomUUID } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";

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

import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Group } from "../src/db/generated/client.js";
import {
  FALLBACK_BETA,
  toAnthropicMessages,
} from "../src/llm-agent/anthropic.js";
import type { ConfigStore, LlmTarget } from "../src/llm-agent/config-store.js";
import {
  SKIP_THOUGHT_SIGNATURE,
  toGeminiContents,
} from "../src/llm-agent/gemini.js";
import {
  AUDIT_SYSTEM_PROMPT,
  TURN_SYSTEM_PROMPT,
} from "../src/llm-agent/prompts.js";
import type { AgentMessage } from "../src/llm-agent/protocol.js";
import {
  sessionDirFor,
  type SessionStore,
} from "../src/llm-agent/session-store.js";
import {
  AGENT_TOOLS,
  onInboundMessage,
} from "../src/services/agent-run-service.js";
import { createAgentClient } from "../src/services/agent-client.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { runAgentTick } from "../src/workers/agent-worker.js";
import { runOutboxTick } from "../src/workers/outbox-worker.js";
import * as A from "./fake-anthropic.js";
import * as G from "./fake-gemini.js";
import { makeAccount, makeGroup, makeMessage } from "./factories.js";
import {
  ADMIN_TOKEN,
  buildTestLlmAgent,
  tempLlmAgentDir,
} from "./llm-agent-harness.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const API_KEY = "sk-ant-test-key-0123456789abcd";
const GEMINI_KEY = "AIza-test-gemini-key-9876543210";

const CONTEXT = JSON.stringify({
  groupId: "g-1",
  triggerMessages: [
    { msgId: "m-1", senderPlatformUserId: "u-1", text: "有人吗", sentAt: "t" },
  ],
  policy: { autoKickEnabled: false },
  ownPlatformUserIds: ["pu-self"],
});

const firstTurn: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: CONTEXT }] },
];

/** 历史里的一轮：assistant tool_use + user tool_result（2.2 形状，后端传回来的样子） */
const step = (
  id: string,
  name: string,
  input: Json,
  result: string,
  isError = false,
): AgentMessage[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
];

const CLAUDE: LlmTarget = {
  provider: "anthropic",
  apiKey: API_KEY,
  model: "claude-opus-5-5",
  auditModel: "claude-haiku-4-5",
};
const GEMINI: LlmTarget = {
  provider: "gemini",
  apiKey: GEMINI_KEY,
  model: "gemini-3-flash-preview",
  auditModel: null,
};

/** 收集 llm-agent 的日志行：断言 key 明文从未进日志 */
const logLines: string[] = [];
const captureLogs = {
  level: "info",
  stream: { write: (line: string) => void logLines.push(line) },
};

describe("llm-agent（C2 / #21）", () => {
  let claude: A.FakeAnthropic;
  let gemini: G.FakeGemini;
  let agent: FastifyInstance;
  let store: ConfigStore;
  let sessions: SessionStore;
  let filePath: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    claude = await A.startFakeAnthropic();
    gemini = await G.startFakeGemini();
    const tmp = await tempLlmAgentDir();
    ({ store, sessions, filePath, cleanup } = tmp);
    agent = await buildTestLlmAgent({
      store,
      sessions,
      anthropicUrl: claude.url,
      geminiUrl: gemini.url,
      logger: captureLogs,
    });
  });

  beforeEach(async () => {
    claude.reset();
    gemini.reset();
    await store.save(CLAUDE);
  });

  afterAll(async () => {
    await agent.close();
    await claude.app.close();
    await gemini.app.close();
    await cleanup();
  });

  const turn = (
    messages: AgentMessage[],
    runId = "run-1",
    tools: unknown = AGENT_TOOLS,
  ) =>
    agent.inject({
      method: "POST",
      url: "/agent/turn",
      payload: { runId, tools, messages },
    });

  const audit = (text: string) =>
    agent.inject({
      method: "POST",
      url: "/agent/audit",
      payload: { text, groupId: "g-1" },
    });

  const lastClaude = (): Json =>
    claude.received[claude.received.length - 1]?.body ?? {};
  const lastGemini = (): Json =>
    gemini.received[gemini.received.length - 1]?.body ?? {};

  // ---- 1. Claude ---------------------------------------------------------------------------

  describe("Claude /agent/turn", () => {
    it("带大图的请求（> 1 MB 默认上限）照常受理，image 块原样转给 Claude（后端 #61）", async () => {
      claude.turnScript.push(
        A.callTool("toolu_img", "finish", { summary: "看到了" }),
      );
      const data = Buffer.alloc(1024 * 1024 + 100).toString("base64");
      const res = await turn([
        {
          role: "user",
          content: [
            { type: "text", text: "{}" },
            {
              type: "image",
              msgId: "m1",
              source: { type: "base64", media_type: "image/jpeg", data },
            },
          ],
        },
      ]);
      expect(res.statusCode).toBe(200);
      const sent = (lastClaude().messages as { content: Json[] }[])[0]!.content;
      expect(sent[1]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
      });
    });

    it("tools / messages 直通，系统提示、tool_choice auto（不并行）、adaptive 思考 + low effort、x-api-key、拒绝兜底", async () => {
      claude.turnScript.push(
        A.callTool("toolu_1", "get_recent_messages", { limit: 10 }),
      );
      const history: AgentMessage[] = [
        ...firstTurn,
        ...step(
          "toolu_0",
          "send_message",
          { text: "在的", idempotency_key: "k-1" },
          '{"code":"AUDIT_REJECTED","message":"没过审"}',
          true,
        ),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "PROTOCOL_ERROR BAD_JSON: 响应体不是合法 JSON",
            },
          ],
        },
      ];
      const res = await turn(history, "run-shape");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_recent_messages",
            input: { limit: 10 },
          },
        ],
      });

      const req = claude.received[0];
      expect(req?.url).toBe("/v1/messages?beta=true");
      expect(req?.headers["x-api-key"]).toBe(API_KEY);
      expect(req?.headers.authorization).toBeUndefined();
      expect(req?.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
      const body = req?.body ?? {};
      expect(body).toMatchObject({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        system: TURN_SYSTEM_PROMPT,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        fallbacks: "default",
      });
      expect(body.tools).toEqual(
        AGENT_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      );
      // messages 原样（记不到思考块的 toolu_0 只发 tool_use；is_error 保留；相邻 user 不合并）
      expect(body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: CONTEXT }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_0",
              name: "send_message",
              input: { text: "在的", idempotency_key: "k-1" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_0",
              content: '{"code":"AUDIT_REJECTED","message":"没过审"}',
              is_error: true,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "PROTOCOL_ERROR BAD_JSON: 响应体不是合法 JSON",
            },
          ],
        },
      ]);
    });

    it("不在文档默认兜底名单里的模型不带 fallbacks 与 beta 头", async () => {
      await store.save({ ...CLAUDE, model: "claude-haiku-4-5" });
      claude.turnScript.push(A.say("好的"));
      expect((await turn(firstTurn, "run-haiku")).statusCode).toBe(200);
      expect(lastClaude().fallbacks).toBeUndefined();
      expect(claude.received[0]?.headers["anthropic-beta"]).toBeUndefined();
    });

    it("思考块按 runId 回传：下一轮把 assistant tool_use 换回上游返回的完整 content；别的 run 不串；重启后照样", async () => {
      claude.turnScript.push(
        A.message(
          [
            A.thinking("sig-A"),
            A.text("先看看消息"),
            A.toolUse("toolu_a", "get_recent_messages", { limit: 5 }),
          ],
          "tool_use",
        ),
      );
      const first = await turn(firstTurn, "run-replay");
      expect(first.json()).toMatchObject({
        stop_reason: "tool_use",
        content: [{ id: "toolu_a" }],
      });
      expect(first.json<{ content: unknown[] }>().content).toHaveLength(1);

      const second: AgentMessage[] = [
        ...firstTurn,
        ...step(
          "toolu_a",
          "get_recent_messages",
          { limit: 5 },
          '{"messages":[],"truncated":false}',
        ),
      ];
      claude.turnScript.push(
        A.callTool(
          "toolu_b",
          "send_message",
          { text: "在", idempotency_key: "k" },
          "sig-B",
        ),
      );
      await turn(second, "run-replay");
      expect((lastClaude().messages as Json[])[1]).toEqual({
        role: "assistant",
        content: [
          A.thinking("sig-A"),
          A.text("先看看消息"),
          A.toolUse("toolu_a", "get_recent_messages", { limit: 5 }),
        ],
      });

      // 同样的历史、另一个 runId：没有记忆，只发 tool_use
      claude.turnScript.push(A.say("好"));
      await turn(second, "run-other");
      expect((lastClaude().messages as Json[])[1]).toEqual({
        role: "assistant",
        content: [A.toolUse("toolu_a", "get_recent_messages", { limit: 5 })],
      });

      // llm-agent 重启（新实例、同一个配置目录）：记忆还在
      const restarted = await buildTestLlmAgent({
        store,
        sessions,
        anthropicUrl: claude.url,
        geminiUrl: gemini.url,
      });
      claude.turnScript.push(
        A.callTool("toolu_c", "finish", { summary: "好了" }),
      );
      const third = await restarted.inject({
        method: "POST",
        url: "/agent/turn",
        payload: {
          runId: "run-replay",
          tools: AGENT_TOOLS,
          messages: [
            ...second,
            ...step(
              "toolu_b",
              "send_message",
              { text: "在", idempotency_key: "k" },
              '{"deliveryStatus":"sent"}',
            ),
          ],
        },
      });
      expect(third.statusCode).toBe(200);
      await restarted.close();
      const replayed = lastClaude().messages as Json[];
      expect((replayed[1]?.content as Json[])[0]).toEqual(A.thinking("sig-A"));
      expect(replayed[3]?.content).toEqual([
        A.thinking("sig-B"),
        A.toolUse("toolu_b", "send_message", {
          text: "在",
          idempotency_key: "k",
        }),
      ]);
      // finish 之后这个 run 的记忆被清掉
      expect((await sessions.load("run-replay")).size).toBe(0);
      expect((await sessions.load("run-other")).size).toBe(0);
    });

    it("换了模型：之前记住的（另一个模型的）思考块不回传", async () => {
      claude.turnScript.push(
        A.callTool("toolu_m", "get_recent_messages", { limit: 1 }),
      );
      await turn(firstTurn, "run-switch");
      await store.save({ ...CLAUDE, model: "claude-sonnet-5-5" });
      claude.turnScript.push(A.say("好"));
      await turn(
        [
          ...firstTurn,
          ...step("toolu_m", "get_recent_messages", { limit: 1 }, "{}"),
        ],
        "run-switch",
      );
      expect((lastClaude().messages as Json[])[1]?.content).toEqual([
        A.toolUse("toolu_m", "get_recent_messages", { limit: 1 }),
      ]);
    });

    it("触发消息的图片（后端 #61）：image 块转成 Claude 的 image 块、Gemini 的 inlineData，紧跟在上下文 text 后面", () => {
      const withImage: AgentMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: '{"groupId":"g1"}' },
            {
              type: "image",
              msgId: "m1",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw==",
              },
            },
          ],
        },
      ];
      expect(toAnthropicMessages(withImage, () => undefined).messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: '{"groupId":"g1"}' },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw==",
              },
            },
          ],
        },
      ]);
      expect(toGeminiContents(withImage, () => undefined).contents).toEqual([
        {
          role: "user",
          parts: [
            { text: '{"groupId":"g1"}' },
            { inlineData: { mimeType: "image/png", data: "iVBORw==" } },
          ],
        },
      ]);
    });

    it("记不到时的规则（纯函数）：前面连续记不到的允许，之后照常回传；回传开始后遇到记不到的，从那里起不再回传", () => {
      const history: AgentMessage[] = [
        ...firstTurn,
        ...step("t1", "get_recent_messages", { limit: 1 }, "{}"),
        ...step("t2", "get_recent_messages", { limit: 2 }, "{}"),
        ...step("t3", "get_recent_messages", { limit: 3 }, "{}"),
        ...step("t4", "get_recent_messages", { limit: 4 }, "{}"),
      ];
      const full = (id: string): Json[] => [
        A.thinking(`sig-${id}`),
        A.toolUse(id, "get_recent_messages", {}),
      ];
      const assistants = (recalled: Record<string, Json[]>) =>
        toAnthropicMessages(history, (id) => recalled[id])
          .messages.filter((m) => m.role === "assistant")
          .map((m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === "thinking")
              ? "思考"
              : "裸",
          );

      // t1 记不到（最前面），t2、t3 记得到 → 回传；t4 记不到
      expect(assistants({ t2: full("t2"), t3: full("t3") })).toEqual([
        "裸",
        "思考",
        "思考",
        "裸",
      ]);
      // t1 记得到，t2 记不到（中间）→ t3 即使记得到也不回传
      expect(
        assistants({ t1: full("t1"), t3: full("t3"), t4: full("t4") }),
      ).toEqual(["思考", "裸", "裸", "裸"]);
      // 记忆内容坏了（不是块数组）按记不到处理
      expect(assistants({ t1: [] as Json[], t2: full("t2") })).toEqual([
        "裸",
        "思考",
        "裸",
        "裸",
      ]);
    });

    it("end_turn：拼 text（思考块不出现）；没有 text 给默认 summary；这个 run 的记忆清掉", async () => {
      claude.turnScript.push(
        A.callTool("toolu_e", "get_recent_messages", { limit: 1 }),
      );
      await turn(firstTurn, "run-end");
      expect((await sessions.load("run-end")).size).toBe(1);

      claude.turnScript.push(
        A.message([A.thinking("s"), A.text("已经处理完了")]),
      );
      const done = await turn(firstTurn, "run-end");
      expect(done.json()).toEqual({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已经处理完了" }],
      });
      expect((await sessions.load("run-end")).size).toBe(0);

      claude.turnScript.push(A.message([A.thinking("s")]));
      expect((await turn(firstTurn)).json()).toEqual({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "模型没有给出总结，本次处理已结束。" }],
      });
    });

    it("refusal → end_turn，text 写明模型拒绝与类别；不记忆", async () => {
      claude.turnScript.push(
        A.message([], "refusal", {
          stop_details: {
            type: "refusal",
            category: "cyber",
            explanation: null,
          },
        }),
      );
      const res = await turn(firstTurn, "run-refusal");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "模型拒绝了这次请求（类别：cyber），本次处理结束。",
          },
        ],
      });
      expect((await sessions.load("run-refusal")).size).toBe(0);
    });

    it("多个 tool_use 只取第一个，记忆也只到第一个为止（后端只会回一个 tool_result）", async () => {
      claude.turnScript.push(
        A.message(
          [
            A.thinking("sig-multi"),
            A.toolUse("toolu_x", "get_recent_messages", { limit: 3 }),
            A.toolUse("toolu_y", "finish", { summary: "x" }),
          ],
          "tool_use",
        ),
      );
      const res = await turn(firstTurn, "run-multi");
      expect(res.json()).toEqual({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_x",
            name: "get_recent_messages",
            input: { limit: 3 },
          },
        ],
      });
      expect(
        (await sessions.load("run-multi")).get("toolu_x")?.content,
      ).toEqual([
        A.thinking("sig-multi"),
        A.toolUse("toolu_x", "get_recent_messages", { limit: 3 }),
      ]);
    });

    it("服务端 fallback：标记块及之前的内容不回传；在工具调用处被 max_tokens 截断 → 502", async () => {
      claude.turnScript.push(
        A.message(
          [
            {
              type: "fallback",
              from: { model: "claude-opus-5-5" },
              to: { model: "claude-opus-5" },
            },
            A.thinking("sig-fb"),
            A.toolUse("toolu_fb", "get_recent_messages", { limit: 1 }),
          ],
          "tool_use",
          { model: "claude-opus-5" },
        ),
      );
      await turn(firstTurn, "run-fb");
      expect((await sessions.load("run-fb")).get("toolu_fb")?.content).toEqual([
        A.thinking("sig-fb"),
        A.toolUse("toolu_fb", "get_recent_messages", { limit: 1 }),
      ]);

      claude.turnScript.push(
        A.message(
          [
            A.thinking("s"),
            A.toolUse("toolu_cut", "send_message", { text: "半" }),
          ],
          "max_tokens",
        ),
      );
      const cut = await turn(firstTurn);
      expect(cut.statusCode).toBe(502);
      expect(cut.json()).toMatchObject({ error: { code: "UPSTREAM_ERROR" } });
    });

    it("上游 401 → 502 不重试，报错里回显的 key 被抹掉", async () => {
      claude.turnScript.push({
        status: 401,
        body: A.apiError(
          "authentication_error",
          `invalid x-api-key ${API_KEY}`,
        ),
      });
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: { code: "UPSTREAM_ERROR", upstreamStatus: 401 },
      });
      expect(res.body).not.toContain(API_KEY);
      expect(res.body).toContain("***");
      expect(claude.received).toHaveLength(1);
    });

    it("持续 5xx：SDK 有界重试（maxRetries=2 → 共 3 次）后 502；429 一次后成功 → 200", async () => {
      for (let i = 0; i < 3; i += 1) {
        claude.turnScript.push({
          status: 529,
          body: A.apiError("overloaded_error", "Overloaded"),
        });
      }
      const down = await turn(firstTurn);
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({ error: { upstreamStatus: 529 } });
      expect(claude.received).toHaveLength(3);

      claude.reset();
      claude.turnScript.push(
        { status: 429, body: A.apiError("rate_limit_error", "slow down") },
        A.say("好"),
      );
      expect((await turn(firstTurn)).statusCode).toBe(200);
      expect(claude.received).toHaveLength(2);
    });

    it("上游超过预算不返回 → 502（不再重试）", async () => {
      const slow = await buildTestLlmAgent({
        store,
        sessions,
        anthropicUrl: claude.url,
        geminiUrl: gemini.url,
        turnTimeoutMs: 300,
      });
      claude.turnScript.push({ hang: true });
      const res = await slow.inject({
        method: "POST",
        url: "/agent/turn",
        payload: { runId: "run-slow", tools: AGENT_TOOLS, messages: firstTurn },
      });
      await slow.close();
      expect(res.statusCode).toBe(502);
      expect(
        res.json<{ error: { message: string } }>().error.message,
      ).toContain("300ms");
      expect(claude.received).toHaveLength(1);
    });
  });

  describe("Claude /agent/audit", () => {
    it("pass：审计模型、审核提示词、结构化输出（json_schema，verdict 枚举）、不带 tools", async () => {
      claude.auditScript.push(A.verdict("pass", "正常问候"));
      const res = await audit("大家好");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verdict: "pass", reason: "正常问候" });
      const body = lastClaude();
      expect(body).toMatchObject({
        model: "claude-haiku-4-5",
        system: AUDIT_SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["pass", "fail"] },
                reason: { type: "string" },
              },
              required: ["verdict", "reason"],
              additionalProperties: false,
            },
          },
        },
      });
      expect(body.tools).toBeUndefined();
      expect(body.messages).toEqual([
        {
          role: "user",
          content: JSON.stringify({ groupId: "g-1", text: "大家好" }),
        },
      ]);
    });

    it("fail：kick 的 JSON 文本原样交给模型", async () => {
      claude.auditScript.push(A.verdict("fail", "理由含糊"));
      const kickText = JSON.stringify({
        action: "kick",
        platform_user_id: "u-9",
        reason: "不喜欢",
      });
      expect((await audit(kickText)).json()).toEqual({
        verdict: "fail",
        reason: "理由含糊",
      });
      expect(lastClaude().messages).toEqual([
        {
          role: "user",
          content: JSON.stringify({ groupId: "g-1", text: kickText }),
        },
      ]);
    });

    it("拿不到结论 → 500 AUDIT_UNAVAILABLE：不是 JSON / verdict 是别的值 / 拒绝 / 上游持续 503（不宽松解析）", async () => {
      claude.auditScript.push(
        A.message([A.text('```json\n{"verdict":"pass","reason":"x"}\n```')]),
        A.verdict("maybe"),
        A.message([], "refusal"),
        ...Array.from({ length: 3 }, () => ({
          status: 503,
          body: A.apiError("api_error", "down"),
        })),
      );
      for (let i = 0; i < 4; i += 1) {
        const res = await audit("hi");
        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({
          error: { code: "AUDIT_UNAVAILABLE" },
        });
      }
    });
  });

  // ---- 2. Gemini ---------------------------------------------------------------------------

  describe("Gemini /agent/turn 与 /agent/audit", () => {
    beforeEach(async () => {
      await store.save(GEMINI);
    });

    it("functionDeclarations（input_schema 原样）、systemInstruction、AUTO、Gemini 3 思考等级 LOW、contents 映射、x-goog-api-key", async () => {
      gemini.turnScript.push(
        G.candidate([
          G.functionCall(
            "get_recent_messages",
            { limit: 10 },
            { id: "fc-1", signature: "gsig-1" },
          ),
        ]),
      );
      const res = await turn(
        [
          ...firstTurn,
          ...step(
            "tu_0",
            "send_message",
            { text: "在的", idempotency_key: "k-1" },
            '{"code":"AUDIT_REJECTED"}',
            true,
          ),
          {
            role: "user",
            content: [{ type: "text", text: "PROTOCOL_ERROR BAD_JSON: x" }],
          },
        ],
        "run-g-shape",
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "fc-1",
            name: "get_recent_messages",
            input: { limit: 10 },
          },
        ],
      });
      const req = gemini.received[0];
      expect(req?.url).toBe(
        "/v1beta/models/gemini-3-flash-preview:generateContent",
      );
      expect(req?.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
      const body = req?.body ?? {};
      expect(body.systemInstruction).toMatchObject({
        parts: [{ text: TURN_SYSTEM_PROMPT }],
      });
      expect(body.tools).toEqual([
        {
          functionDeclarations: AGENT_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.input_schema,
          })),
        },
      ]);
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: "AUTO" },
      });
      expect(body.generationConfig).toMatchObject({
        thinkingConfig: { thinkingLevel: "LOW" },
      });
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: CONTEXT }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "tu_0",
                name: "send_message",
                args: { text: "在的", idempotency_key: "k-1" },
              },
              thoughtSignature: SKIP_THOUGHT_SIGNATURE,
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "tu_0",
                name: "send_message",
                response: { error: { code: "AUDIT_REJECTED" } },
              },
            },
            { text: "PROTOCOL_ERROR BAD_JSON: x" },
          ],
        },
      ]);
    });

    it("thoughtSignature 按 runId 回传：上游没给 id 时生成 id，下一轮换回原样的 model Content，functionResponse 不带 id", async () => {
      gemini.turnScript.push(
        G.candidate([
          { text: "想一想", thought: true },
          G.functionCall(
            "get_recent_messages",
            { limit: 5 },
            { signature: "gsig-A" },
          ),
        ]),
      );
      const first = await turn(firstTurn, "run-g-replay");
      const id =
        first.json<{ content: { id: string }[] }>().content[0]?.id ?? "";
      expect(id).toMatch(/^call_/);

      gemini.turnScript.push(G.say("好了"));
      const second = await turn(
        [
          ...firstTurn,
          ...step(id, "get_recent_messages", { limit: 5 }, '{"messages":[]}'),
        ],
        "run-g-replay",
      );
      expect(second.json()).toEqual({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "好了" }],
      });
      const contents = lastGemini().contents as Json[];
      expect(contents[1]).toEqual({
        role: "model",
        parts: [
          { text: "想一想", thought: true },
          {
            functionCall: { name: "get_recent_messages", args: { limit: 5 } },
            thoughtSignature: "gsig-A",
          },
        ],
      });
      expect(contents[2]).toEqual({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "get_recent_messages",
              response: { output: { messages: [] } },
            },
          },
        ],
      });
      // end_turn 后记忆清掉
      expect((await sessions.load("run-g-replay")).size).toBe(0);
    });

    it("多个 functionCall 只取第一个；安全拦截 → end_turn 拒绝；MALFORMED_FUNCTION_CALL / 没有候选 → 502", async () => {
      gemini.turnScript.push(
        G.candidate([
          G.functionCall(
            "get_recent_messages",
            { limit: 1 },
            { id: "p-1", signature: "s" },
          ),
          G.functionCall("finish", { summary: "x" }, { id: "p-2" }),
        ]),
      );
      expect((await turn(firstTurn, "run-g-multi")).json()).toMatchObject({
        content: [{ id: "p-1", name: "get_recent_messages" }],
      });
      expect(
        (
          (await sessions.load("run-g-multi")).get("p-1")?.content as {
            parts: unknown[];
          }
        ).parts,
      ).toHaveLength(1);

      gemini.turnScript.push(G.candidate([], "SAFETY"));
      expect((await turn(firstTurn)).json()).toEqual({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "模型拒绝了这次请求（SAFETY），本次处理结束。",
          },
        ],
      });

      gemini.turnScript.push({
        body: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } },
      });
      expect(
        (await turn(firstTurn)).json<{ content: { text: string }[] }>()
          .content[0]?.text,
      ).toContain("PROHIBITED_CONTENT");

      gemini.turnScript.push(G.candidate([], "MALFORMED_FUNCTION_CALL"), {
        body: { candidates: [] },
      });
      expect((await turn(firstTurn)).statusCode).toBe(502);
      expect((await turn(firstTurn)).statusCode).toBe(502);
    });

    it("上游 401 → 502 不重试（key 抹掉）；持续 503 → 重试后 502；不返回 → 502", async () => {
      gemini.turnScript.push({
        status: 401,
        body: G.geminiError(401, "UNAUTHENTICATED", `bad key ${GEMINI_KEY}`),
      });
      const unauthorized = await turn(firstTurn);
      expect(unauthorized.statusCode).toBe(502);
      expect(unauthorized.json()).toMatchObject({
        error: { upstreamStatus: 401 },
      });
      expect(unauthorized.body).not.toContain(GEMINI_KEY);
      expect(gemini.received).toHaveLength(1);

      gemini.reset();
      for (let i = 0; i < 3; i += 1) {
        gemini.turnScript.push({
          status: 503,
          body: G.geminiError(503, "UNAVAILABLE", "overloaded"),
        });
      }
      expect((await turn(firstTurn)).statusCode).toBe(502);
      expect(gemini.received).toHaveLength(3);

      const slow = await buildTestLlmAgent({
        store,
        sessions,
        anthropicUrl: claude.url,
        geminiUrl: gemini.url,
        turnTimeoutMs: 300,
      });
      gemini.turnScript.push({ hang: true });
      const res = await slow.inject({
        method: "POST",
        url: "/agent/turn",
        payload: {
          runId: "run-g-slow",
          tools: AGENT_TOOLS,
          messages: firstTurn,
        },
      });
      await slow.close();
      expect(res.statusCode).toBe(502);
      expect(
        res.json<{ error: { message: string } }>().error.message,
      ).toContain("300ms");
    });

    it("audit：responseMimeType application/json + responseJsonSchema，审计模型缺省同 model；非 JSON → 500", async () => {
      gemini.auditScript.push(G.verdict("pass", "正常"));
      expect((await audit("大家好")).json()).toEqual({
        verdict: "pass",
        reason: "正常",
      });
      const req = gemini.received[0];
      expect(req?.url).toBe(
        "/v1beta/models/gemini-3-flash-preview:generateContent",
      );
      expect(req?.body.systemInstruction).toMatchObject({
        parts: [{ text: AUDIT_SYSTEM_PROMPT }],
      });
      expect(req?.body.generationConfig).toMatchObject({
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
          required: ["verdict", "reason"],
        },
      });
      expect(req?.body.tools).toBeUndefined();

      gemini.auditScript.push(
        G.candidate([{ text: "pass" }]),
        G.candidate([], "SAFETY"),
      );
      expect((await audit("hi")).statusCode).toBe(500);
      const blocked = await audit("hi");
      expect(blocked.statusCode).toBe(500);
      expect(
        blocked.json<{ error: { message: string } }>().error.message,
      ).toContain("SAFETY");
    });
  });

  // ---- 3. 请求校验与未配置 ---------------------------------------------------------------------

  describe("请求校验与未配置", () => {
    it("tools 不是题目规定的 4 个 / required 不全 → 400 TOOLS_INVALID；缺 runId → 400 VALIDATION_ERROR；都不调上游", async () => {
      const three = await turn(firstTurn, "run-1", AGENT_TOOLS.slice(0, 3));
      expect(three.statusCode).toBe(400);
      expect(three.json()).toMatchObject({ error: { code: "TOOLS_INVALID" } });

      const tools = AGENT_TOOLS.map((t) =>
        t.name === "send_message"
          ? { ...t, input_schema: { ...t.input_schema, required: ["text"] } }
          : t,
      );
      expect((await turn(firstTurn, "run-1", tools)).statusCode).toBe(400);

      const noRun = await agent.inject({
        method: "POST",
        url: "/agent/turn",
        payload: { tools: AGENT_TOOLS, messages: firstTurn },
      });
      expect(noRun.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
      expect(claude.received).toHaveLength(0);
    });

    it("没有配置文件 → /agent/turn、/agent/audit 503 LLM_NOT_CONFIGURED，不调上游", async () => {
      const tmp = await tempLlmAgentDir();
      const bare = await buildTestLlmAgent({
        store: tmp.store,
        sessions: tmp.sessions,
        anthropicUrl: claude.url,
        geminiUrl: gemini.url,
      });
      const t = await bare.inject({
        method: "POST",
        url: "/agent/turn",
        payload: { runId: "r", tools: AGENT_TOOLS, messages: firstTurn },
      });
      expect(t.statusCode).toBe(503);
      expect(t.json()).toMatchObject({ error: { code: "LLM_NOT_CONFIGURED" } });
      expect(t.json<{ error: { message: string } }>().error.message).toContain(
        "模型设置",
      );
      const a = await bare.inject({
        method: "POST",
        url: "/agent/audit",
        payload: { text: "hi", groupId: "g" },
      });
      expect(a.statusCode).toBe(503);
      await bare.close();
      await tmp.cleanup();
      expect(claude.received).toHaveLength(0);
      expect(gemini.received).toHaveLength(0);
    });
  });

  // ---- 4. 管理端点 --------------------------------------------------------------------------

  describe("管理端点 /admin/*", () => {
    const call = async (
      method: "GET" | "PUT" | "POST",
      url: string,
      payload?: Json,
      token = ADMIN_TOKEN,
    ) => {
      const res = await agent.inject({
        method,
        url,
        headers: { "x-admin-token": token },
        ...(payload ? { payload } : {}),
      });
      expect(res.body).not.toContain(API_KEY);
      expect(res.body).not.toContain(GEMINI_KEY);
      return res;
    };

    it("没带 / 带错 x-admin-token → 401", async () => {
      const none = await agent.inject({ method: "GET", url: "/admin/config" });
      expect(none.statusCode).toBe(401);
      expect(
        (await call("GET", "/admin/config", undefined, "wrong")).statusCode,
      ).toBe(401);
    });

    it("PUT 保存 → 视图只有 key 提示；文件 600；服务商切换不沿用 key；同一服务商沿用", async () => {
      const saved = await call("PUT", "/admin/config", {
        provider: "anthropic",
        apiKey: API_KEY,
        model: "claude-opus-5-5",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({
        provider: "anthropic",
        model: "claude-opus-5-5",
        auditModel: null,
        hasApiKey: true,
        apiKeyHint: "sk-…abcd",
        updatedAt: expect.any(String) as unknown,
        source: "file",
      });
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await call("GET", "/admin/config")).json()).toEqual(saved.json());

      const kept = await call("PUT", "/admin/config", {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        auditModel: "claude-haiku-4-5",
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json()).toMatchObject({
        model: "claude-sonnet-5-5",
        auditModel: "claude-haiku-4-5",
        hasApiKey: true,
      });

      for (const [url, payload] of [
        [
          "/admin/config",
          { provider: "gemini", model: "gemini-3-flash-preview" },
        ],
        ["/admin/models", { provider: "gemini" }],
      ] as const) {
        const res = await call(
          url === "/admin/config" ? "PUT" : "POST",
          url,
          payload,
        );
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({
          error: { code: "LLM_API_KEY_REQUIRED" },
        });
      }
      // Claude 的 key 没被发往 Gemini，配置不变
      expect(gemini.received).toHaveLength(0);
      expect((await call("GET", "/admin/config")).json()).toMatchObject({
        provider: "anthropic",
      });

      const switched = await call("PUT", "/admin/config", {
        provider: "gemini",
        apiKey: GEMINI_KEY,
        model: "gemini-3-flash-preview",
      });
      expect(switched.json()).toMatchObject({
        provider: "gemini",
        apiKeyHint: "AIz…3210",
      });

      const bad = await call("PUT", "/admin/config", {
        provider: "other",
        apiKey: "k",
        model: "m",
      });
      expect(bad.statusCode).toBe(400);
    });

    it("配置文件是旧格式 → GET 500 LLM_CONFIG_INVALID 并说明怎么修；带 key 重新保存即可覆盖", async () => {
      await writeFile(
        filePath,
        // 更早版本的文件：没有 provider 字段
        JSON.stringify({
          apiKey: "k",
          model: "m",
          auditModel: null,
          updatedAt: "t",
        }),
      );
      const broken = await call("GET", "/admin/config");
      expect(broken.statusCode).toBe(500);
      expect(broken.json()).toMatchObject({
        error: { code: "LLM_CONFIG_INVALID" },
      });
      expect(
        broken.json<{ error: { message: string } }>().error.message,
      ).toContain("重新保存");
      const fixed = await call("PUT", "/admin/config", {
        provider: "anthropic",
        apiKey: API_KEY,
        model: "claude-opus-5-5",
      });
      expect(fixed.statusCode).toBe(200);
    });

    it("POST /admin/models：Claude 只留支持 adaptive 思考 / low effort / 结构化输出的；Gemini 只留支持 generateContent 的", async () => {
      claude.modelsScript.push(
        A.modelsPage([
          A.modelInfo("claude-opus-5-5"),
          A.modelInfo("claude-old", { adaptive: false }),
          A.modelInfo("claude-no-schema", { structured: false }),
          A.modelInfo("claude-haiku-4-5"),
        ]),
      );
      const listed = await call("POST", "/admin/models", {
        provider: "anthropic",
        apiKey: API_KEY,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        items: [
          { id: "claude-opus-5-5", displayName: "Display claude-opus-5-5" },
          { id: "claude-haiku-4-5", displayName: "Display claude-haiku-4-5" },
        ],
        total: 2,
      });
      expect(claude.received[0]?.headers["x-api-key"]).toBe(API_KEY);

      gemini.modelsScript.push(
        G.modelsPage([
          {
            name: "models/gemini-3-flash-preview",
            displayName: "Gemini 3 Flash",
            methods: ["generateContent", "countTokens"],
          },
          { name: "models/text-embedding-005", methods: ["embedContent"] },
          { name: "models/gemini-2.5-flash", methods: ["generateContent"] },
        ]),
      );
      const g = await call("POST", "/admin/models", {
        provider: "gemini",
        apiKey: GEMINI_KEY,
      });
      expect(g.json()).toEqual({
        items: [
          { id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash" },
          { id: "gemini-2.5-flash", displayName: "gemini-2.5-flash" },
        ],
        total: 2,
      });
      expect(gemini.received[0]?.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    });

    it("POST /admin/models：上游 401 / 403（Gemini 还有 400 API_KEY_INVALID）→ 422 LLM_UPSTREAM_UNAUTHORIZED；其他 4xx / 5xx → 502 LLM_UPSTREAM_ERROR（报错不含 key）", async () => {
      claude.modelsScript.push({
        status: 401,
        body: A.apiError("authentication_error", `bad ${API_KEY}`),
      });
      const unauthorized = await call("POST", "/admin/models", {
        provider: "anthropic",
        apiKey: API_KEY,
      });
      expect(unauthorized.statusCode).toBe(422);
      expect(unauthorized.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_UNAUTHORIZED" },
      });

      gemini.modelsScript.push({
        status: 403,
        body: G.geminiError(403, "PERMISSION_DENIED", "nope"),
      });
      expect(
        (
          await call("POST", "/admin/models", {
            provider: "gemini",
            apiKey: GEMINI_KEY,
          })
        ).statusCode,
      ).toBe(422);

      // Gemini 对无效 key 回 400 INVALID_ARGUMENT + ErrorInfo.reason API_KEY_INVALID（实测），同样算 key 被拒；
      // 别的 400 不算
      gemini.modelsScript.push(
        {
          status: 400,
          body: {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "API_KEY_INVALID",
                  domain: "googleapis.com",
                },
              ],
            },
          },
        },
        {
          status: 400,
          body: G.geminiError(400, "INVALID_ARGUMENT", "bad request"),
        },
      );
      const invalidKey = await call("POST", "/admin/models", {
        provider: "gemini",
        apiKey: GEMINI_KEY,
      });
      expect(invalidKey.statusCode).toBe(422);
      expect(invalidKey.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_UNAUTHORIZED" },
      });
      expect(
        (
          await call("POST", "/admin/models", {
            provider: "gemini",
            apiKey: GEMINI_KEY,
          })
        ).statusCode,
      ).toBe(502);

      for (let i = 0; i < 3; i += 1) {
        claude.modelsScript.push({
          status: 500,
          body: A.apiError("api_error", `down ${API_KEY}`),
        });
      }
      const down = await call("POST", "/admin/models", {
        provider: "anthropic",
        apiKey: API_KEY,
      });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_ERROR" },
      });
      expect(
        down.json<{ error: { message: string } }>().error.message,
      ).toContain("***");
    });

    it("POST /admin/test：带工具历史的对话 + 审计都走一遍；对话失败 / 审计拿不到结论 → ok=false（仍 200）", async () => {
      claude.turnScript.push(A.say("连接正常"));
      claude.auditScript.push(A.verdict("pass"));
      const ok = await call("POST", "/admin/test");
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, model: "claude-opus-5-5" });
      expect(typeof ok.json<Json>().latencyMs).toBe("number");
      // 对话请求带着一轮 tool_use + tool_result 历史（没有思考块 = 记不到时的真实形状）
      expect(
        (claude.received[0]?.body.messages as Json[]).map((m) => m.role),
      ).toEqual(["user", "assistant", "user"]);
      expect(claude.received[1]?.body.model).toBe("claude-haiku-4-5");

      claude.turnScript.push({
        status: 400,
        body: A.apiError("invalid_request_error", "bad thinking"),
      });
      const turnFail = await call("POST", "/admin/test");
      expect(turnFail.json()).toMatchObject({
        ok: false,
        model: "claude-opus-5-5",
      });
      expect(turnFail.json<{ message: string }>().message).toContain(
        "bad thinking",
      );

      claude.turnScript.push(A.say("连接正常"));
      claude.auditScript.push(A.message([A.text("not json")]));
      const auditFail = await call("POST", "/admin/test");
      expect(auditFail.json()).toMatchObject({ ok: false });
      expect(auditFail.json<{ message: string }>().message).toContain("审计");

      await store.save(GEMINI);
      gemini.turnScript.push(G.say("连接正常"));
      gemini.auditScript.push(G.verdict("pass"));
      expect((await call("POST", "/admin/test")).json()).toMatchObject({
        ok: true,
        model: "gemini-3-flash-preview",
      });
      // 没有签名的历史用文档的占位值
      const probe = gemini.received[0]?.body.contents as Json[];
      expect((probe[1]?.parts as Json[])[0]?.thoughtSignature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      );
    });

    it("整个文件里 key 明文从未进过 llm-agent 的日志；会话状态目录只有 600 的文件", async () => {
      expect(logLines.length).toBeGreaterThan(0);
      expect(
        logLines.filter((l) => l.includes(API_KEY) || l.includes(GEMINI_KEY)),
      ).toEqual([]);
      const dir = sessionDirFor(filePath);
      for (const name of await readdir(dir)) {
        expect((await stat(`${dir}/${name}`)).mode & 0o777).toBe(0o600);
      }
    });
  });
});

// ---- 5. 全链路：后端 agent run → llm-agent → 假 Anthropic ------------------------------------

describe("全链路：后端 AGENT_URL 指向 llm-agent（Claude）", () => {
  const silent = logger.child({}, { level: "silent" });
  let now = Date.now();
  const clock: Clock = { now: () => new Date(now) };
  let claude: A.FakeAnthropic;
  let gemini: G.FakeGemini;
  let llmAgent: FastifyInstance;
  let gatewaySim: FastifyInstance;
  let gatewayClient: GatewayClient;
  let agentUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    claude = await A.startFakeAnthropic();
    gemini = await G.startFakeGemini();
    const tmp = await tempLlmAgentDir();
    cleanup = tmp.cleanup;
    await tmp.store.save({ ...CLAUDE, auditModel: null });
    llmAgent = await buildTestLlmAgent({
      store: tmp.store,
      sessions: tmp.sessions,
      anthropicUrl: claude.url,
      geminiUrl: gemini.url,
      maxRetries: 0,
    });
    agentUrl = await llmAgent.listen({ port: 0, host: "127.0.0.1" });
    gatewaySim = await buildGatewayApp({ logger: false, clock });
    gatewayClient = createGatewayClient({
      baseUrl: await gatewaySim.listen({ port: 0, host: "127.0.0.1" }),
    });
  });

  beforeEach(async () => {
    await truncateAll();
    claude.reset();
    now = Date.now();
    await gatewaySim.inject({ method: "POST", url: "/_sim/reset" });
    await gatewaySim.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload: { send: { acceptDelayMs: 0, eventDelayMs: 0 } },
    });
  });

  afterEach(() => {
    expect(gemini.received).toHaveLength(0);
  });

  afterAll(async () => {
    await llmAgent.close();
    await claude.app.close();
    await gemini.app.close();
    await gatewaySim.close();
    await cleanup();
    await closeDb();
  });

  /** 布景（同 tests/agent-run.test.ts）：在线群主（本地 + 网关）建群，本地成员表写群主 */
  async function stageGroup(): Promise<Group> {
    const creatorId = `acc-${randomUUID().slice(0, 8)}`;
    const connected = await gatewaySim.inject({
      method: "POST",
      url: `/accounts/${creatorId}/connect`,
    });
    const { platformUserId } = connected.json<{ platformUserId: string }>();
    await makeAccount({ id: creatorId, status: "online", platformUserId });
    const created = await gatewaySim.inject({
      method: "POST",
      url: "/groups",
      payload: { creatorAccountId: creatorId },
    });
    const { groupId } = created.json<{ groupId: string }>();
    const group = await makeGroup({
      creatorAccountId: creatorId,
      gatewayGroupId: groupId,
      agentEnabled: true,
    });
    await getDb().groupMember.create({
      data: {
        groupId: group.id,
        platformUserId,
        accountId: creatorId,
        role: "creator",
      },
    });
    return group;
  }

  it("get_recent_messages → send_message → finish：run finished / final，三步，网关恰好一条，第三轮回传了前两轮的思考块", async () => {
    const group = await stageGroup();
    const msg = await makeMessage({
      groupId: group.id,
      msgId: `m-${randomUUID().slice(0, 8)}`,
      senderPlatformUserId: "u-ext-1",
      isOwn: false,
      text: "有人在吗",
      sentAt: clock.now(),
    });
    const outcome = await getDb().$transaction((tx) =>
      onInboundMessage(
        { groupId: group.id, messageId: msg.id },
        { tx, clock, log: silent },
      ),
    );
    expect(outcome.kind).toBe("run_created");
    if (outcome.kind !== "run_created") throw new Error("unreachable");

    claude.turnScript.push(
      A.callTool("toolu_a", "get_recent_messages", { limit: 10 }, "sig-a"),
      A.callTool(
        "toolu_b",
        "send_message",
        { text: "在的，请讲", idempotency_key: "k-1" },
        "sig-b",
      ),
      A.callTool("toolu_c", "finish", { summary: "已回复用户" }, "sig-c"),
    );
    claude.auditScript.push(A.verdict("pass", "正常回复"));

    const agentClient = createAgentClient({ baseUrl: agentUrl });
    const outboxTick = () =>
      runOutboxTick({
        clock,
        gateway: gatewayClient,
        workerId: "outbox-w1",
        log: silent,
      });
    for (let i = 0; i < 10; i += 1) {
      const r = await runAgentTick({
        clock,
        agent: agentClient,
        gateway: gatewayClient,
        workerId: "agent-w1",
        log: silent,
        turnTimeoutMs: 5_000,
        auditTimeoutMs: 5_000,
        // agent 等 deliveryStatus 时：拨时钟 + 派发一次出站，不真等
        sleep: async (ms) => {
          now += ms;
          await outboxTick();
        },
      });
      if (!r || r.outcome === "ended") break;
    }

    const run = await getDb().agentRun.findUniqueOrThrow({
      where: { id: outcome.runId },
    });
    expect(run.status).toBe("finished");
    expect(run.endReason).toBe("final");
    expect(run.summary).toBe("已回复用户");
    const steps = await getDb().agentStep.findMany({
      where: { runId: run.id },
      orderBy: { index: "asc" },
    });
    expect(steps.map((s) => [s.kind, s.name, s.toolUseId, s.isError])).toEqual([
      ["tool_use", "get_recent_messages", "toolu_a", false],
      ["tool_use", "send_message", "toolu_b", false],
      ["final", "finish", "toolu_c", false],
    ]);
    expect(steps[1]?.auditVerdict).toBe("pass");

    const gw = (
      await gatewaySim.inject({ method: "GET", url: "/_sim/state" })
    ).json<{ sendCalls: unknown[] }>();
    expect(gw.sendCalls).toHaveLength(1);

    // 上游看到的第三轮：两个 assistant 回合都换回了带思考块的完整 content，tool_result 按 id 配对
    const turns = claude.received.filter((r) => Array.isArray(r.body.tools));
    expect(turns).toHaveLength(3);
    const third = turns[2]?.body.messages as Json[];
    expect(third.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(
      JSON.parse(String((third[0]?.content as Json[])[0]?.text)),
    ).toMatchObject({
      groupId: group.gatewayGroupId,
      triggerMessages: [{ text: "有人在吗", senderPlatformUserId: "u-ext-1" }],
    });
    expect(third[1]?.content).toEqual([
      A.thinking("sig-a"),
      A.toolUse("toolu_a", "get_recent_messages", { limit: 10 }),
    ]);
    expect((third[3]?.content as Json[])[0]).toEqual(A.thinking("sig-b"));
    expect((third[4]?.content as Json[])[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_b",
    });
    // auditModel 没设 → 审计用同一个模型
    const audits = claude.received.filter((r) => !Array.isArray(r.body.tools));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.body.model).toBe("claude-opus-5-5");
  });
});
