// 题目 C2（issue #19）：真实 LLM 版 Agent 服务（src/llm-agent）。
// 上游是**假 OpenAI 服务**（tests/fake-openai.ts，listen(0)，按剧本返回、记录请求），不打外网。
// 上游配置只来自控制台保存的配置文件：每组用例在临时目录里放一份（store.save），用完删掉。
// 四部分：
// 1. /agent/turn：协议翻译（两个方向）、每轮恰好一个块、非法 arguments、上游 429 / 5xx / 超时 / 形状不对 → 502、
//    未配置 → 503、Authorization 头、服务商参数。
// 2. /agent/audit：pass / fail / 解析不了 → 500、json_object。
// 3. 管理端点 /admin/*：令牌、配置读写与 key 沿用规则、文件 600 与重启后读回、/models、测试连接、明文不出现在响应与日志。
// 4. 全链路：后端 agent run（真库 + 网关模拟器 + runAgentTick）把 Agent 客户端指向 llm-agent，run 正常 finished / final。
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

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
  createConfigStore,
  type ConfigStore,
} from "../src/llm-agent/config-store.js";
import { providerParams } from "../src/llm-agent/providers.js";
import {
  toOpenAiMessages,
  type AnthropicMessage,
} from "../src/llm-agent/translate.js";
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
import {
  ADMIN_TOKEN,
  buildTestLlmAgent,
  callTools,
  completion,
  say,
  startFakeOpenAi,
  tempConfigFile,
  toolCall,
  verdict,
  type FakeOpenAi,
} from "./fake-openai.js";
import { makeAccount, makeGroup, makeMessage } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const API_KEY = "sk-test-key-0123456789abcd";

const CONTEXT = JSON.stringify({
  groupId: "g-1",
  triggerMessages: [
    { msgId: "m-1", senderPlatformUserId: "u-1", text: "有人吗", sentAt: "t" },
  ],
  policy: { autoKickEnabled: false },
  ownPlatformUserIds: ["pu-self"],
});

const turnBody = (
  messages: AnthropicMessage[],
  tools: unknown = AGENT_TOOLS,
) => ({ runId: "run-1", tools, messages });

const firstTurn: AnthropicMessage[] = [
  { role: "user", content: [{ type: "text", text: CONTEXT }] },
];

/** 收集 llm-agent 的日志行：断言 key 明文从未进日志 */
const logLines: string[] = [];
const captureLogs = {
  level: "info",
  stream: { write: (line: string) => void logLines.push(line) },
};

describe("llm-agent（C2 / #19）", () => {
  let fake: FakeOpenAi;
  let agent: FastifyInstance;
  let store: ConfigStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    fake = await startFakeOpenAi();
    const tmp = await tempConfigFile();
    cleanup = tmp.cleanup;
    store = createConfigStore({ filePath: tmp.filePath });
    await store.save({
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
      model: "turn-model",
      auditModel: "audit-model",
    });
    agent = await buildTestLlmAgent({ store, logger: captureLogs });
  });

  beforeEach(() => fake.reset());

  afterAll(async () => {
    await agent.close();
    await fake.app.close();
    await cleanup();
  });

  const turn = (messages: AnthropicMessage[], tools?: unknown) =>
    agent.inject({
      method: "POST",
      url: "/agent/turn",
      payload: turnBody(messages, tools),
    });

  const audit = (text: string) =>
    agent.inject({
      method: "POST",
      url: "/agent/audit",
      payload: { text, groupId: "g-1" },
    });

  const lastBody = (): Json =>
    fake.received[fake.received.length - 1]?.body ?? {};

  // ---- /agent/turn：请求方向 -------------------------------------------------------------------

  describe("/agent/turn 请求翻译（Anthropic → OpenAI）", () => {
    it("tools、tool_use / tool_result 配对、is_error 前缀、PROTOCOL_ERROR 文本、模型、Authorization", async () => {
      fake.turnScript.push(
        callTools(toolCall("call_z", "finish", { summary: "好了" })),
      );
      const res = await turn([
        ...firstTurn,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "get_recent_messages",
              input: { limit: 10 },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: '{"messages":[],"truncated":false}',
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_2",
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
              tool_use_id: "tu_2",
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
      expect(res.statusCode).toBe(200);

      expect(fake.received).toHaveLength(1);
      const req = fake.received[0];
      expect(req?.url).toBe("/v1/chat/completions");
      expect(req?.headers.authorization).toBe(`Bearer ${API_KEY}`);
      const body = req?.body ?? {};
      expect(body).toMatchObject({ model: "turn-model", tool_choice: "auto" });
      // 本地假服务不是已知服务商：不加服务商参数；parallel_tool_calls / temperature 从不发
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("parallel_tool_calls");
      expect(body).not.toHaveProperty("temperature");
      // tools：input_schema → function.parameters，原样
      expect(body.tools).toEqual(
        AGENT_TOOLS.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
      );
      const messages = body.messages as Json[];
      expect(messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
        "user",
      ]);
      expect(messages[0]?.content).toContain("finish");
      expect(messages[0]?.content).toContain("ownPlatformUserIds");
      // 触发上下文原样
      expect(messages[1]).toEqual({ role: "user", content: CONTEXT });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tu_1",
            type: "function",
            function: {
              name: "get_recent_messages",
              arguments: '{"limit":10}',
            },
          },
        ],
      });
      expect(messages[3]).toEqual({
        role: "tool",
        tool_call_id: "tu_1",
        content: '{"messages":[],"truncated":false}',
      });
      expect((messages[4]?.tool_calls as Json[])[0]).toMatchObject({
        id: "tu_2",
        function: {
          name: "send_message",
          arguments: '{"text":"在的","idempotency_key":"k-1"}',
        },
      });
      expect(messages[5]?.tool_call_id).toBe("tu_2");
      expect(messages[5]?.content).toMatch(
        /^工具调用失败（is_error=true）.*AUDIT_REJECTED/,
      );
      expect(messages[6]).toEqual({
        role: "user",
        content: "PROTOCOL_ERROR BAD_JSON: 响应体不是合法 JSON",
      });
    });

    it("纯函数：相邻 user 文本合并；配不上的 tool_result 降级成 user 文本；没结果的 tool_call 补占位", () => {
      const out = toOpenAiMessages(
        [
          ...firstTurn,
          {
            role: "user",
            content: [
              { type: "text", text: "PROTOCOL_ERROR TURN_TIMEOUT: 超时" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_x", content: "{}" },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu_9",
                name: "get_recent_messages",
                input: { limit: 5 },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: "PROTOCOL_ERROR BAD_JSON: x" }],
          },
        ],
        "SYS",
      );
      expect(out).toEqual([
        { role: "system", content: "SYS" },
        {
          role: "user",
          content: `${CONTEXT}\n\nPROTOCOL_ERROR TURN_TIMEOUT: 超时\n\n工具调用 tu_x 的结果：{}`,
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tu_9",
              type: "function",
              function: {
                name: "get_recent_messages",
                arguments: '{"limit":5}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tu_9",
          content: JSON.stringify({
            code: "NO_RESULT",
            message: "这次工具调用没有返回结果",
          }),
        },
        { role: "user", content: "PROTOCOL_ERROR BAD_JSON: x" },
      ]);
    });

    it("服务商参数：DeepSeek / MiMo / kimi-k2.6 关思考，其余 Kimi 模型与未知服务商不加", () => {
      const off = { thinking: { type: "disabled" } };
      expect(
        providerParams("https://api.deepseek.com", "deepseek-flash"),
      ).toEqual(off);
      expect(
        providerParams("https://api.xiaomimimo.com/v1", "mimo-v2.6-flash"),
      ).toEqual(off);
      expect(providerParams("https://api.moonshot.ai/v1", "kimi-k2.6")).toEqual(
        off,
      );
      expect(providerParams("https://api.moonshot.ai/v1", "kimi-k3")).toEqual(
        {},
      );
      expect(
        providerParams(
          "https://generativelanguage.googleapis.com/v1beta/openai/",
          "gemini-3.8-flash",
        ),
      ).toEqual({});
      // 主机名要整段匹配：evil-deepseek.com 不算
      expect(providerParams("https://evil-deepseek.com", "x")).toEqual({});
    });
  });

  // ---- /agent/turn：响应方向 -------------------------------------------------------------------

  describe("/agent/turn 响应翻译（OpenAI → 恰好一个块）", () => {
    it("tool_calls → stop_reason tool_use，id / name / input 对应", async () => {
      fake.turnScript.push(
        callTools(toolCall("call_abc", "get_recent_messages", { limit: 20 })),
      );
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "call_abc",
            name: "get_recent_messages",
            input: { limit: 20 },
          },
        ],
      });
    });

    it("多个 tool_calls 只取第一个", async () => {
      fake.turnScript.push(
        callTools(
          toolCall("call_1", "send_message", {
            text: "a",
            idempotency_key: "k-a",
          }),
          toolCall("call_2", "finish", { summary: "b" }),
        ),
      );
      const res = await turn(firstTurn);
      const body = res.json<{ content: Json[] }>();
      expect(body.content).toHaveLength(1);
      expect(body.content[0]).toMatchObject({
        id: "call_1",
        name: "send_message",
      });
    });

    it("arguments 不是合法 JSON → 仍是 tool_use，input 为 {}（后端判 INVALID_INPUT 回灌，模型可自纠）", async () => {
      fake.turnScript.push(
        callTools(toolCall("call_bad", "send_message", '{"text": "hi", ')),
      );
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "call_bad", name: "send_message", input: {} },
        ],
      });
    });

    it("upstream 的 tool_call.id 与历史重复或缺失 → 换一个新 id（避免后端判 DUPLICATE_TOOL_USE_ID）", async () => {
      const history: AnthropicMessage[] = [
        ...firstTurn,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_0",
              name: "get_recent_messages",
              input: { limit: 5 },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_0", content: "{}" },
          ],
        },
      ];
      fake.turnScript.push(
        callTools(toolCall("call_0", "finish", { summary: "x" })),
      );
      const dup = (await turn(history)).json<{ content: { id: string }[] }>();
      expect(dup.content[0]?.id).toMatch(/^call_/);
      expect(dup.content[0]?.id).not.toBe("call_0");

      fake.turnScript.push(
        callTools({
          type: "function",
          function: { name: "finish", arguments: '{"summary":"y"}' },
        }),
      );
      const missing = (await turn(firstTurn)).json<{
        content: { id: string }[];
      }>();
      expect(missing.content[0]?.id).toMatch(/^call_[0-9a-f]{32}$/);
    });

    it("没有 tool_calls → end_turn + text；text 为空给默认 summary；reasoning_content 不回传", async () => {
      fake.turnScript.push(
        completion({ content: "  处理完了  ", reasoning_content: "想了很久" }),
      );
      const res = await turn(firstTurn);
      expect(res.json()).toEqual({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "处理完了" }],
      });
      expect(res.body).not.toContain("想了很久");

      fake.turnScript.push(say(null));
      const empty = await turn(firstTurn);
      expect(
        empty.json<{ content: { text: string }[] }>().content[0]?.text,
      ).toBe("模型没有给出总结，本次处理已结束。");
    });
  });

  // ---- /agent/turn：上游失败 ------------------------------------------------------------------

  describe("/agent/turn 上游失败 → 502（后端记 BAD_JSON）", () => {
    it("持续 500：有界重试（maxRetries=2 → 共 3 次）后 502 UPSTREAM_ERROR", async () => {
      for (let i = 0; i < 3; i += 1) {
        fake.turnScript.push({
          status: 500,
          body: { error: { message: "boom" } },
        });
      }
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: { code: "UPSTREAM_ERROR", upstreamStatus: 500, attempts: 3 },
      });
      expect(
        res.json<{ error: { message: string } }>().error.message,
      ).toContain("boom");
      expect(fake.received).toHaveLength(3);
    });

    it("429 一次后成功 → 200（重试成功）", async () => {
      fake.turnScript.push(
        {
          status: 429,
          body: { error: { message: "rate limited" } },
          headers: { "retry-after": "0" },
        },
        callTools(toolCall("call_ok", "finish", { summary: "ok" })),
      );
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(200);
      expect(fake.received).toHaveLength(2);
    });

    it("401 不重试，直接 502；上游报错里回显的 key 被抹掉", async () => {
      fake.turnScript.push({
        status: 401,
        body: { error: { message: `Incorrect API key provided: ${API_KEY}` } },
      });
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: { upstreamStatus: 401, attempts: 1 },
      });
      expect(res.body).not.toContain(API_KEY);
      expect(res.body).toContain("***");
      expect(fake.received).toHaveLength(1);
    });

    it("上游超过预算不返回 → 502，不再重试", async () => {
      const slow = await buildTestLlmAgent({ store, turnTimeoutMs: 300 });
      fake.turnScript.push({ hang: true });
      const res = await slow.inject({
        method: "POST",
        url: "/agent/turn",
        payload: turnBody(firstTurn),
      });
      await slow.close();
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: { code: "UPSTREAM_ERROR", upstreamStatus: null, attempts: 1 },
      });
      expect(
        res.json<{ error: { message: string } }>().error.message,
      ).toContain("300ms");
    });

    it("200 但不是 chat completion 形状 / 不是 JSON → 502", async () => {
      fake.turnScript.push({ body: { error: { message: "quota exceeded" } } });
      expect((await turn(firstTurn)).statusCode).toBe(502);
      fake.turnScript.push({ raw: "<html>gateway</html>" });
      const res = await turn(firstTurn);
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        "上游响应不是合法 JSON",
      );
    });
  });

  describe("/agent/turn 请求校验", () => {
    it("tools 不是题目规定的 4 个 → 400 TOOLS_INVALID，不调上游", async () => {
      const res = await turn(firstTurn, AGENT_TOOLS.slice(0, 3));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "TOOLS_INVALID" } });
      expect(fake.received).toHaveLength(0);
    });

    it("required 没覆盖全部入参 → 400 TOOLS_INVALID", async () => {
      const tools = AGENT_TOOLS.map((t) =>
        t.name === "send_message"
          ? { ...t, input_schema: { ...t.input_schema, required: ["text"] } }
          : t,
      );
      const res = await turn(firstTurn, tools);
      expect(res.statusCode).toBe(400);
      expect(
        res.json<{ error: { issues: string[] } }>().error.issues,
      ).toContain("tools[1].input_schema.required 未覆盖 idempotency_key");
    });

    it("缺 runId / messages 为空 → 400 VALIDATION_ERROR", async () => {
      const res = await agent.inject({
        method: "POST",
        url: "/agent/turn",
        payload: { tools: AGENT_TOOLS, messages: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    });
  });

  // ---- /agent/audit --------------------------------------------------------------------------

  describe("/agent/audit", () => {
    it("pass：请求用审计模型、审核提示词、json_object、不带 tools；user 消息含 text 与 groupId", async () => {
      fake.auditScript.push(verdict("pass", "正常问候"));
      const res = await audit("大家好");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verdict: "pass", reason: "正常问候" });
      const body = lastBody();
      expect(body).toMatchObject({
        model: "audit-model",
        response_format: { type: "json_object" },
      });
      expect(body).not.toHaveProperty("tools");
      const messages = body.messages as Json[];
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toContain("JSON");
      expect(JSON.parse(String(messages[1]?.content))).toEqual({
        groupId: "g-1",
        text: "大家好",
      });
    });

    it("fail：kick 的 JSON 文本原样交给模型", async () => {
      fake.auditScript.push(verdict("fail", "理由含糊"));
      const kickText = JSON.stringify({
        action: "kick",
        platform_user_id: "u-9",
        reason: "不喜欢",
      });
      const res = await audit(kickText);
      expect(res.json()).toEqual({ verdict: "fail", reason: "理由含糊" });
      const user = (lastBody().messages as Json[])[1];
      expect(JSON.parse(String(user?.content))).toEqual({
        groupId: "g-1",
        text: kickText,
      });
    });

    it("模型包了代码围栏 → 剥掉后照常解析", async () => {
      fake.auditScript.push(
        say('```json\n{"verdict":"pass","reason":"ok"}\n```'),
      );
      expect((await audit("hi")).json()).toEqual({
        verdict: "pass",
        reason: "ok",
      });
    });

    it("前后夹着说明文字（没开 JSON 模式时常见）→ 取出其中的 JSON 对象照常解析", async () => {
      fake.auditScript.push(
        say('判定如下：{"verdict":"fail","reason":"含广告链接"}，请知悉。'),
      );
      expect((await audit("hi")).json()).toEqual({
        verdict: "fail",
        reason: "含广告链接",
      });
    });

    it("服务商拒绝 JSON 模式（400）→ 去掉 response_format 重试一次，拿到结论", async () => {
      fake.auditScript.push({
        status: 400,
        body: { error: { message: "response_format is not supported" } },
      });
      fake.auditScript.push(say('{"verdict":"pass","reason":"正常内容"}'));
      const res = await audit("hi");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ verdict: "pass", reason: "正常内容" });
      expect(fake.received).toHaveLength(2);
      expect(fake.received[0]?.body.response_format).toEqual({
        type: "json_object",
      });
      expect(fake.received[1]?.body).not.toHaveProperty("response_format");
    });

    it("限流 / 故障（429、5xx）不触发去掉 JSON 模式的重试", async () => {
      for (let i = 0; i < 3; i += 1)
        fake.auditScript.push({ status: 429, body: {} });
      const res = await audit("hi");
      expect(res.statusCode).toBe(500);
      expect(
        fake.received.every(
          (r) =>
            (r.body.response_format as { type?: string } | undefined)?.type ===
            "json_object",
        ),
      ).toBe(true);
    });

    it("模型输出不是 JSON / verdict 是别的值 → 500 AUDIT_UNAVAILABLE（后端重试后 blocked）", async () => {
      fake.auditScript.push(say("我觉得可以"));
      const notJson = await audit("hi");
      expect(notJson.statusCode).toBe(500);
      expect(notJson.json()).toMatchObject({
        error: { code: "AUDIT_UNAVAILABLE" },
      });

      fake.auditScript.push(verdict("maybe"));
      expect((await audit("hi")).statusCode).toBe(500);
    });

    it("上游持续 503 → 500", async () => {
      for (let i = 0; i < 3; i += 1)
        fake.auditScript.push({ status: 503, body: {} });
      const res = await audit("hi");
      expect(res.statusCode).toBe(500);
      expect(fake.received).toHaveLength(3);
    });
  });

  // ---- 未配置 ----------------------------------------------------------------------------------

  describe("未配置（没有配置文件）", () => {
    it("/agent/turn、/agent/audit → 503 LLM_NOT_CONFIGURED，提示去控制台配置，不调上游", async () => {
      const tmp = await tempConfigFile();
      const bare = await buildTestLlmAgent({
        store: createConfigStore({ filePath: tmp.filePath }),
      });
      const t = await bare.inject({
        method: "POST",
        url: "/agent/turn",
        payload: turnBody(firstTurn),
      });
      const a = await bare.inject({
        method: "POST",
        url: "/agent/audit",
        payload: { text: "hi", groupId: "g" },
      });
      await bare.close();
      await tmp.cleanup();
      for (const res of [t, a]) {
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({
          error: { code: "LLM_NOT_CONFIGURED" },
        });
        expect(
          res.json<{ error: { message: string } }>().error.message,
        ).toContain("模型设置");
      }
      expect(fake.received).toHaveLength(0);
    });
  });

  // ---- 管理端点 -------------------------------------------------------------------------------

  describe("管理端点 /admin/*", () => {
    let admin: FastifyInstance;
    let adminFile: string;
    let adminCleanup: () => Promise<void>;

    beforeEach(async () => {
      const tmp = await tempConfigFile();
      adminFile = tmp.filePath;
      adminCleanup = tmp.cleanup;
      admin = await buildTestLlmAgent({
        store: createConfigStore({ filePath: adminFile }),
        logger: captureLogs,
      });
    });

    afterEach(async () => {
      await admin.close();
      await adminCleanup();
    });

    const call = async (
      method: "GET" | "PUT" | "POST",
      url: string,
      payload?: Json,
      token: string | null = ADMIN_TOKEN,
    ) => {
      const res = await admin.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: token ? { "x-admin-token": token } : {},
      });
      // 任何响应里都没有 key 明文
      expect(res.body).not.toContain(API_KEY);
      return res;
    };

    const save = (payload: Json) => call("PUT", "/admin/config", payload);

    it("没带 / 带错 x-admin-token → 401", async () => {
      expect(
        (await call("GET", "/admin/config", undefined, null)).statusCode,
      ).toBe(401);
      const wrong = await call("POST", "/admin/test", undefined, "nope");
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("GET 未配置 → source none；PUT 保存 → 视图只有 key 提示；文件 600；重启后读回并立即生效", async () => {
      const empty = await call("GET", "/admin/config");
      expect(empty.json()).toEqual({
        baseUrl: null,
        model: null,
        auditModel: null,
        hasApiKey: false,
        apiKeyHint: null,
        updatedAt: null,
        source: "none",
      });

      const saved = await save({
        baseUrl: `${fake.baseUrl}/`,
        apiKey: API_KEY,
        model: "turn-model",
      });
      expect(saved.statusCode).toBe(200);
      const view = saved.json<Json>();
      expect(view).toMatchObject({
        baseUrl: fake.baseUrl, // 末尾的 / 去掉
        model: "turn-model",
        auditModel: null,
        hasApiKey: true,
        apiKeyHint: "sk-…abcd",
        source: "file",
      });
      expect(Number.isNaN(Date.parse(String(view.updatedAt)))).toBe(false);
      expect((await stat(adminFile)).mode & 0o777).toBe(0o600);

      // 「重启」：同一个文件新建一个实例
      const restarted = await buildTestLlmAgent({
        store: createConfigStore({ filePath: adminFile }),
      });
      const again = await restarted.inject({
        method: "GET",
        url: "/admin/config",
        headers: { "x-admin-token": ADMIN_TOKEN },
      });
      expect(again.json()).toEqual(view);
      fake.turnScript.push(
        callTools(toolCall("call_r", "finish", { summary: "ok" })),
      );
      const t = await restarted.inject({
        method: "POST",
        url: "/agent/turn",
        payload: turnBody(firstTurn),
      });
      await restarted.close();
      expect(t.statusCode).toBe(200);
      expect(lastBody().model).toBe("turn-model");
    });

    it("apiKey 省略：同一 baseUrl 沿用旧 key；换了 baseUrl → 422 LLM_API_KEY_REQUIRED；从未存过 → 422", async () => {
      const none = await save({ baseUrl: fake.baseUrl, model: "m" });
      expect(none.statusCode).toBe(422);
      expect(none.json()).toMatchObject({
        error: { code: "LLM_API_KEY_REQUIRED" },
      });

      await save({ baseUrl: fake.baseUrl, apiKey: API_KEY, model: "m1" });
      const kept = await save({
        baseUrl: fake.baseUrl,
        model: "m2",
        auditModel: "m-audit",
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.json()).toMatchObject({
        model: "m2",
        auditModel: "m-audit",
        hasApiKey: true,
        apiKeyHint: "sk-…abcd",
      });
      // 沿用的确实是旧 key：下一次上游请求带着它，审计用 auditModel
      fake.auditScript.push(verdict("pass"));
      await admin.inject({
        method: "POST",
        url: "/agent/audit",
        payload: { text: "hi", groupId: "g" },
      });
      expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(fake.received[0]?.body.model).toBe("m-audit");

      // 换主机不沿用（防止把已存的 key 发给别的主机），已存的配置不变
      const other = await save({
        baseUrl: "https://attacker.example/v1",
        model: "m3",
      });
      expect(other.statusCode).toBe(422);
      expect(other.json()).toMatchObject({
        error: { code: "LLM_API_KEY_REQUIRED" },
      });
      expect((await call("GET", "/admin/config")).json()).toMatchObject({
        model: "m2",
      });

      // 形状错 → 400
      const bad = await save({ baseUrl: "ftp://x", apiKey: "k", model: "m" });
      expect(bad.statusCode).toBe(400);
    });

    it("POST /admin/models：按 id 排序、ownedBy；key 沿用规则同 PUT；401 → 422；500 / 非列表 → 502，报错不含 key", async () => {
      fake.modelsScript.push({
        body: {
          object: "list",
          data: [
            { id: "z-model", object: "model", owned_by: "acme" },
            { id: "a-model", object: "model" },
          ],
        },
      });
      const ok = await call("POST", "/admin/models", {
        baseUrl: fake.baseUrl,
        apiKey: API_KEY,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({
        models: [
          { id: "a-model", ownedBy: null },
          { id: "z-model", ownedBy: "acme" },
        ],
      });
      expect(fake.received[0]).toMatchObject({
        method: "GET",
        url: "/v1/models",
      });
      expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);

      const noKey = await call("POST", "/admin/models", {
        baseUrl: fake.baseUrl,
      });
      expect(noKey.statusCode).toBe(422);
      expect(noKey.json()).toMatchObject({
        error: { code: "LLM_API_KEY_REQUIRED" },
      });

      fake.modelsScript.push({
        status: 401,
        body: { error: { message: `bad key ${API_KEY}` } },
      });
      const unauthorized = await call("POST", "/admin/models", {
        baseUrl: fake.baseUrl,
        apiKey: API_KEY,
      });
      expect(unauthorized.statusCode).toBe(422);
      expect(unauthorized.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_UNAUTHORIZED" },
      });

      fake.modelsScript.push({
        status: 500,
        body: { error: { message: `down ${API_KEY}` } },
      });
      const down = await call("POST", "/admin/models", {
        baseUrl: fake.baseUrl,
        apiKey: API_KEY,
      });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_ERROR" },
      });
      expect(
        down.json<{ error: { message: string } }>().error.message,
      ).toContain("down ***");

      fake.modelsScript.push({ body: { hello: "world" } });
      const shape = await call("POST", "/admin/models", {
        baseUrl: fake.baseUrl,
        apiKey: API_KEY,
      });
      expect(shape.statusCode).toBe(502);
    });

    it("POST /admin/test：未配置 ok=false；成功时带工具历史的对话 + 审计都走一遍；对话失败 / 审计非 JSON → ok=false", async () => {
      const unconfigured = await call("POST", "/admin/test");
      expect(unconfigured.statusCode).toBe(200);
      expect(unconfigured.json()).toMatchObject({
        ok: false,
        model: null,
        latencyMs: 0,
      });

      await save({
        baseUrl: fake.baseUrl,
        apiKey: API_KEY,
        model: "turn-model",
      });
      fake.reset();
      fake.turnScript.push(say("连接正常"));
      fake.auditScript.push(verdict("pass"));
      const ok = await call("POST", "/admin/test");
      expect(ok.json()).toMatchObject({ ok: true, model: "turn-model" });
      expect(typeof ok.json<Json>().latencyMs).toBe("number");
      // 对话请求带着一轮 tool_calls + tool 历史（要求回传思考内容的模型会在这里失败）
      const probe = fake.received[0]?.body.messages as Json[];
      expect(probe.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
      expect(fake.received[1]?.body.response_format).toEqual({
        type: "json_object",
      });

      fake.turnScript.push({
        status: 400,
        body: { error: { message: "reasoning_content must be passed back" } },
      });
      const turnFail = await call("POST", "/admin/test");
      expect(turnFail.statusCode).toBe(200);
      expect(turnFail.json()).toMatchObject({
        ok: false,
        model: "turn-model",
      });
      expect(turnFail.json<{ message: string }>().message).toContain(
        "reasoning_content",
      );

      fake.turnScript.push(say("连接正常"));
      fake.auditScript.push(say("not json"));
      const auditFail = await call("POST", "/admin/test");
      expect(auditFail.json()).toMatchObject({ ok: false });
      expect(auditFail.json<{ message: string }>().message).toContain("审计");
    });

    it("整个文件里 key 明文从未进过 llm-agent 的日志", () => {
      expect(logLines.length).toBeGreaterThan(0);
      expect(logLines.filter((l) => l.includes(API_KEY))).toEqual([]);
    });
  });
});

// ---- 全链路：后端 agent run → llm-agent → 假 OpenAI ------------------------------------------

describe("全链路：后端 AGENT_URL 指向 llm-agent", () => {
  const silent = logger.child({}, { level: "silent" });
  let now = Date.now();
  const clock: Clock = { now: () => new Date(now) };
  let fake: FakeOpenAi;
  let llmAgent: FastifyInstance;
  let gatewaySim: FastifyInstance;
  let gatewayClient: GatewayClient;
  let agentUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    fake = await startFakeOpenAi();
    const tmp = await tempConfigFile();
    cleanup = tmp.cleanup;
    const store = createConfigStore({ filePath: tmp.filePath });
    await store.save({
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
      model: "turn-model",
      auditModel: null,
    });
    llmAgent = await buildTestLlmAgent({ store, maxRetries: 0 });
    agentUrl = await llmAgent.listen({ port: 0, host: "127.0.0.1" });
    gatewaySim = await buildGatewayApp({ logger: false, clock });
    gatewayClient = createGatewayClient({
      baseUrl: await gatewaySim.listen({ port: 0, host: "127.0.0.1" }),
    });
  });

  beforeEach(async () => {
    await truncateAll();
    fake.reset();
    now = Date.now();
    await gatewaySim.inject({ method: "POST", url: "/_sim/reset" });
    await gatewaySim.inject({
      method: "POST",
      url: "/_sim/scenario",
      payload: { send: { acceptDelayMs: 0, eventDelayMs: 0 } },
    });
  });

  afterAll(async () => {
    await llmAgent.close();
    await fake.app.close();
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

  it("get_recent_messages → send_message → finish：run finished / final，三步，网关恰好一条，历史里 tool_call_id 对得上", async () => {
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

    fake.turnScript.push(
      callTools(toolCall("call_a", "get_recent_messages", { limit: 10 })),
      callTools(
        toolCall("call_b", "send_message", {
          text: "在的，请讲",
          idempotency_key: "k-1",
        }),
      ),
      callTools(toolCall("call_c", "finish", { summary: "已回复用户" })),
    );
    fake.auditScript.push(verdict("pass", "正常回复"));

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
      ["tool_use", "get_recent_messages", "call_a", false],
      ["tool_use", "send_message", "call_b", false],
      ["final", "finish", "call_c", false],
    ]);
    expect(steps[1]?.auditVerdict).toBe("pass");

    const gw = (
      await gatewaySim.inject({ method: "GET", url: "/_sim/state" })
    ).json<{ sendCalls: unknown[] }>();
    expect(gw.sendCalls).toHaveLength(1);

    // 上游看到的第三轮历史：tool_calls 与 tool 消息按 id 配对，触发上下文原样
    const turns = fake.received.filter((r) => Array.isArray(r.body.tools));
    expect(turns).toHaveLength(3);
    const third = turns[2]?.body.messages as Json[];
    expect(third.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(JSON.parse(String(third[1]?.content))).toMatchObject({
      groupId: group.gatewayGroupId,
      triggerMessages: [{ text: "有人在吗", senderPlatformUserId: "u-ext-1" }],
    });
    expect(third[3]?.tool_call_id).toBe("call_a");
    expect(third[5]?.tool_call_id).toBe("call_b");
    expect(JSON.parse(String(third[5]?.content))).toMatchObject({
      deliveryStatus: "accepted",
    });
    // auditModel 没设 → 审计用同一个模型
    const audits = fake.received.filter((r) => !Array.isArray(r.body.tools));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.body.model).toBe("turn-model");
  });
});
