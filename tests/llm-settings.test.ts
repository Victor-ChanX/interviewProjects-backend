// LLM 设置（#19 / #21，题目 C2）：后端 /api/llm/* 代理 llm-agent 的 /admin/*。服务商只有 Claude 与 Gemini。
// 真链路：后端（buildApp，真库）→ llm-agent（listen(0)，配置文件在临时目录）→ 假 Anthropic / 假 Gemini
// （tests/fake-anthropic.ts、tests/fake-gemini.ts）。
// 覆盖：主流程（读 → 列模型 → 保存 → 测试）、闸门（viewer 只能读）、key 沿用 / 换服务商不沿用、错误码透传、
// supported=false 两个分支（AGENT_URL 指向 Agent 模拟器 / 没配令牌）、令牌不一致、key 明文不出现在任何响应里。
import { rm } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { createLlmAdminClient } from "../src/services/llm-settings-service.js";
import { buildAgentApp } from "../src/sim/agent/app.js";
import * as A from "./fake-anthropic.js";
import * as G from "./fake-gemini.js";
import { loginAs } from "./factories.js";
import {
  ADMIN_TOKEN,
  buildTestLlmAgent,
  tempLlmAgentDir,
} from "./llm-agent-harness.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const API_KEY = "sk-ant-settings-key-9876543210wxyz";
const GEMINI_KEY = "AIza-settings-gemini-key-0123456789";

describe("LLM 设置 /api/llm/*（#19）", () => {
  let fake: A.FakeAnthropic;
  let gemini: G.FakeGemini;
  let llmAgent: FastifyInstance;
  let llmAgentUrl: string;
  let agentSim: FastifyInstance;
  let agentSimUrl: string;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
  let filePath: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    fake = await A.startFakeAnthropic();
    gemini = await G.startFakeGemini();
    const tmp = await tempLlmAgentDir();
    filePath = tmp.filePath;
    cleanup = tmp.cleanup;
    llmAgent = await buildTestLlmAgent({
      store: tmp.store,
      sessions: tmp.sessions,
      anthropicUrl: fake.url,
      geminiUrl: gemini.url,
    });
    llmAgentUrl = await llmAgent.listen({ port: 0, host: "127.0.0.1" });
    agentSim = await buildAgentApp({ logger: false });
    agentSimUrl = await agentSim.listen({ port: 0, host: "127.0.0.1" });
    app = await buildApp({
      logger: false,
      llmAdmin: createLlmAdminClient({
        agentUrl: llmAgentUrl,
        adminToken: ADMIN_TOKEN,
      }),
    });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    fake.reset();
    gemini.reset();
    await rm(filePath, { force: true });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await llmAgent.close();
    await agentSim.close();
    await fake.app.close();
    await gemini.app.close();
    await cleanup();
    await closeDb();
  });

  const call = async (
    target: FastifyInstance,
    method: "GET" | "PUT" | "POST",
    url: string,
    headers: Record<string, string>,
    payload?: Json,
  ) => {
    const res = await target.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    // 任何响应里都没有 key 明文
    expect(res.body).not.toContain(API_KEY);
    expect(res.body).not.toContain(GEMINI_KEY);
    return res;
  };

  it("主流程：未配置 → 列模型 → 保存 → 读回（只有 key 提示）→ 测试连接", async () => {
    const empty = await call(app, "GET", "/api/llm/settings", viewer);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      supported: true,
      provider: null,
      model: null,
      auditModel: null,
      hasApiKey: false,
      apiKeyHint: null,
      updatedAt: null,
      source: "none",
    });

    fake.modelsScript.push(
      A.modelsPage([
        A.modelInfo("claude-opus-5-5"),
        A.modelInfo("claude-legacy", { low: false }),
        A.modelInfo("claude-haiku-4-5"),
      ]),
    );
    const models = await call(app, "POST", "/api/llm/models", admin, {
      provider: "anthropic",
      apiKey: API_KEY,
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({
      items: [
        { id: "claude-opus-5-5", displayName: "Display claude-opus-5-5" },
        { id: "claude-haiku-4-5", displayName: "Display claude-haiku-4-5" },
      ],
      total: 2,
    });
    expect(fake.received[0]?.headers["x-api-key"]).toBe(API_KEY);

    const saved = await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "anthropic",
      apiKey: API_KEY,
      model: "claude-opus-5-5",
      auditModel: "claude-haiku-4-5",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      supported: true,
      provider: "anthropic",
      model: "claude-opus-5-5",
      auditModel: "claude-haiku-4-5",
      hasApiKey: true,
      apiKeyHint: "sk-…wxyz",
      source: "file",
    });

    const read = await call(app, "GET", "/api/llm/settings", viewer);
    expect(read.json()).toEqual(saved.json());

    fake.reset();
    fake.turnScript.push(A.say("连接正常"));
    fake.auditScript.push(A.verdict("pass"));
    const test = await call(app, "POST", "/api/llm/test", admin);
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, model: "claude-opus-5-5" });
    expect(fake.received.map((r) => r.body.model)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
  });

  it("Gemini：列模型（只留支持 generateContent 的）→ 保存 → 测试连接", async () => {
    gemini.modelsScript.push(
      G.modelsPage([
        {
          name: "models/gemini-3-flash-preview",
          displayName: "Gemini 3 Flash",
          methods: ["generateContent"],
        },
        { name: "models/embedding-001", methods: ["embedContent"] },
      ]),
    );
    const models = await call(app, "POST", "/api/llm/models", admin, {
      provider: "gemini",
      apiKey: GEMINI_KEY,
    });
    expect(models.json()).toEqual({
      items: [{ id: "gemini-3-flash-preview", displayName: "Gemini 3 Flash" }],
      total: 1,
    });
    const saved = await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "gemini",
      apiKey: GEMINI_KEY,
      model: "gemini-3-flash-preview",
    });
    expect(saved.json()).toMatchObject({
      provider: "gemini",
      auditModel: null,
      apiKeyHint: "AIz…6789",
    });
    gemini.turnScript.push(G.say("连接正常"));
    gemini.auditScript.push(G.verdict("pass"));
    const test = await call(app, "POST", "/api/llm/test", admin);
    expect(test.json()).toMatchObject({
      ok: true,
      model: "gemini-3-flash-preview",
    });
    expect(fake.received).toHaveLength(0);
  });

  it("闸门：viewer 能读，写 / 列模型 / 测试 → 403；没登录 → 401", async () => {
    expect(
      (await call(app, "GET", "/api/llm/settings", viewer)).statusCode,
    ).toBe(200);
    for (const [method, url, payload] of [
      [
        "PUT",
        "/api/llm/settings",
        { provider: "anthropic", apiKey: API_KEY, model: "m" },
      ],
      ["POST", "/api/llm/models", { provider: "anthropic", apiKey: API_KEY }],
      ["POST", "/api/llm/test", undefined],
    ] as const) {
      const res = await call(app, method, url, viewer, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    expect(fake.received).toHaveLength(0);
    expect((await call(app, "GET", "/api/llm/settings", {})).statusCode).toBe(
      401,
    );
  });

  it("apiKey 省略：同一服务商沿用；换服务商 → 422 LLM_API_KEY_REQUIRED，key 不会发给另一家（保存与列模型都一样）", async () => {
    const first = await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "anthropic",
      model: "m",
    });
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({
      error: { code: "LLM_API_KEY_REQUIRED" },
    });

    await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "anthropic",
      apiKey: API_KEY,
      model: "m1",
    });
    const kept = await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "anthropic",
      model: "m2",
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ model: "m2", hasApiKey: true });

    fake.modelsScript.push(A.modelsPage([A.modelInfo("m2")]));
    const reuse = await call(app, "POST", "/api/llm/models", admin, {
      provider: "anthropic",
    });
    expect(reuse.statusCode).toBe(200);
    expect(fake.received[0]?.headers["x-api-key"]).toBe(API_KEY);

    for (const [method, url] of [
      ["PUT", "/api/llm/settings"],
      ["POST", "/api/llm/models"],
    ] as const) {
      const res = await call(app, method, url, admin, {
        provider: "gemini",
        model: "gemini-3-flash-preview",
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: { code: "LLM_API_KEY_REQUIRED" },
      });
    }
    // 没有任何请求被发往另一家，配置不变
    expect(gemini.received).toHaveLength(0);
    expect(fake.received).toHaveLength(1);
    expect(
      (await call(app, "GET", "/api/llm/settings", admin)).json(),
    ).toMatchObject({ provider: "anthropic", model: "m2" });
  });

  it("上游错误码：401 → 422 LLM_UPSTREAM_UNAUTHORIZED；5xx → 503 LLM_UPSTREAM_ERROR；形状错 → 400", async () => {
    fake.modelsScript.push({
      status: 401,
      body: A.apiError("authentication_error", `invalid key ${API_KEY}`),
    });
    const unauthorized = await call(app, "POST", "/api/llm/models", admin, {
      provider: "anthropic",
      apiKey: API_KEY,
    });
    expect(unauthorized.statusCode).toBe(422);
    expect(unauthorized.json()).toMatchObject({
      error: { code: "LLM_UPSTREAM_UNAUTHORIZED" },
    });

    for (let i = 0; i < 3; i += 1) {
      fake.modelsScript.push({
        status: 500,
        body: A.apiError("api_error", "x"),
      });
    }
    const down = await call(app, "POST", "/api/llm/models", admin, {
      provider: "anthropic",
      apiKey: API_KEY,
    });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      error: { code: "LLM_UPSTREAM_ERROR" },
    });

    const bad = await call(app, "PUT", "/api/llm/settings", admin, {
      provider: "other",
      apiKey: API_KEY,
      model: "m",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("测试连接：未配置时 ok=false（仍是 200）", async () => {
    const res = await call(app, "POST", "/api/llm/test", admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, model: null });
    expect(res.json<{ message: string }>().message).toContain("模型设置");
  });

  describe("不支持的分支", () => {
    it("AGENT_URL 指向 Agent 模拟器（没有 /admin/*）：读 supported=false，写 / 列模型 / 测试 → 409", async () => {
      const simApp = await buildApp({
        logger: false,
        llmAdmin: createLlmAdminClient({
          agentUrl: agentSimUrl,
          adminToken: ADMIN_TOKEN,
        }),
      });
      const simAdmin = await loginAs(simApp, "admin");
      const read = await call(simApp, "GET", "/api/llm/settings", simAdmin);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        supported: false,
        provider: null,
        model: null,
        auditModel: null,
        hasApiKey: false,
        apiKeyHint: null,
        updatedAt: null,
        source: null,
      });
      for (const [method, url, payload] of [
        [
          "PUT",
          "/api/llm/settings",
          { provider: "anthropic", apiKey: API_KEY, model: "m" },
        ],
        ["POST", "/api/llm/models", { provider: "anthropic", apiKey: API_KEY }],
        ["POST", "/api/llm/test", undefined],
      ] as const) {
        const res = await call(simApp, method, url, simAdmin, payload);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({
          error: { code: "LLM_AGENT_UNSUPPORTED" },
        });
      }
      await simApp.close();
    });

    it("没配 LLM_AGENT_ADMIN_TOKEN（客户端为 null）：读 supported=false，测试 → 409", async () => {
      const bare = await buildApp({ logger: false, llmAdmin: null });
      const bareAdmin = await loginAs(bare, "admin");
      const read = await call(bare, "GET", "/api/llm/settings", bareAdmin);
      expect(read.json()).toMatchObject({ supported: false, source: null });
      const test = await call(bare, "POST", "/api/llm/test", bareAdmin);
      expect(test.statusCode).toBe(409);
      expect(test.json()).toMatchObject({
        error: { code: "LLM_AGENT_UNSUPPORTED" },
      });
      await bare.close();
    });

    it("两边令牌不一致 → 503 LLM_UPSTREAM_ERROR，提示检查令牌", async () => {
      const wrong = await buildApp({
        logger: false,
        llmAdmin: createLlmAdminClient({
          agentUrl: llmAgentUrl,
          adminToken: "not-the-token",
        }),
      });
      const wrongAdmin = await loginAs(wrong, "admin");
      const res = await call(wrong, "GET", "/api/llm/settings", wrongAdmin);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        error: { code: "LLM_UPSTREAM_ERROR" },
      });
      expect(
        res.json<{ error: { message: string } }>().error.message,
      ).toContain("LLM_AGENT_ADMIN_TOKEN");
      await wrong.close();
    });
  });
});
