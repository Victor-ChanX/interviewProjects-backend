// LLM 设置（#19，题目 C2）：后端 /api/llm/* 代理 llm-agent 的 /admin/*。
// 真链路：后端（buildApp，真库）→ llm-agent（listen(0)，配置文件在临时目录）→ 假 OpenAI（tests/fake-openai.ts）。
// 覆盖：主流程（读 → 列模型 → 保存 → 测试）、闸门（viewer 只能读）、key 沿用 / 跨主机不沿用、错误码透传、
// supported=false 两个分支（AGENT_URL 指向 Agent 模拟器 / 没配令牌）、令牌不一致、key 明文不出现在任何响应里。
import { rm } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { createConfigStore } from "../src/llm-agent/config-store.js";
import { createLlmAdminClient } from "../src/services/llm-settings-service.js";
import { buildAgentApp } from "../src/sim/agent/app.js";
import {
  ADMIN_TOKEN,
  buildTestLlmAgent,
  say,
  startFakeOpenAi,
  tempConfigFile,
  verdict,
  type FakeOpenAi,
} from "./fake-openai.js";
import { loginAs } from "./factories.js";
import { truncateAll } from "./setup.js";

type Json = Record<string, unknown>;

const API_KEY = "sk-settings-key-9876543210wxyz";

describe("LLM 设置 /api/llm/*（#19）", () => {
  let fake: FakeOpenAi;
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
    fake = await startFakeOpenAi();
    const tmp = await tempConfigFile();
    filePath = tmp.filePath;
    cleanup = tmp.cleanup;
    llmAgent = await buildTestLlmAgent({
      store: createConfigStore({ filePath }),
    });
    llmAgentUrl = await llmAgent.listen({ port: 0, host: "127.0.0.1" });
    agentSim = await buildAgentApp({ logger: false });
    agentSimUrl = await agentSim.listen({ port: 0, host: "127.0.0.1" });
    app = await buildApp({
      logger: false,
      llmAdmin: createLlmAdminClient({
        baseUrl: llmAgentUrl,
        adminToken: ADMIN_TOKEN,
      }),
    });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    fake.reset();
    await rm(filePath, { force: true });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await llmAgent.close();
    await agentSim.close();
    await fake.app.close();
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
    return res;
  };

  it("主流程：未配置 → 列模型 → 保存 → 读回（只有 key 提示）→ 测试连接", async () => {
    const empty = await call(app, "GET", "/api/llm/settings", viewer);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      supported: true,
      baseUrl: null,
      model: null,
      auditModel: null,
      hasApiKey: false,
      apiKeyHint: null,
      updatedAt: null,
      source: "none",
    });

    fake.modelsScript.push({
      body: { data: [{ id: "m-b", owned_by: "x" }, { id: "m-a" }] },
    });
    const models = await call(app, "POST", "/api/llm/models", admin, {
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({
      items: [
        { id: "m-a", ownedBy: null },
        { id: "m-b", ownedBy: "x" },
      ],
      total: 2,
    });
    expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);

    const saved = await call(app, "PUT", "/api/llm/settings", admin, {
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
      model: "m-a",
      auditModel: "m-b",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      supported: true,
      baseUrl: fake.baseUrl,
      model: "m-a",
      auditModel: "m-b",
      hasApiKey: true,
      apiKeyHint: "sk-…wxyz",
      source: "file",
    });

    const read = await call(app, "GET", "/api/llm/settings", viewer);
    expect(read.json()).toEqual(saved.json());

    fake.reset();
    fake.turnScript.push(say("连接正常"));
    fake.auditScript.push(verdict("pass"));
    const test = await call(app, "POST", "/api/llm/test", admin);
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, model: "m-a" });
    expect(fake.received.map((r) => r.body.model)).toEqual(["m-a", "m-b"]);
  });

  it("闸门：viewer 能读，写 / 列模型 / 测试 → 403；没登录 → 401", async () => {
    expect(
      (await call(app, "GET", "/api/llm/settings", viewer)).statusCode,
    ).toBe(200);
    for (const [method, url, payload] of [
      [
        "PUT",
        "/api/llm/settings",
        { baseUrl: fake.baseUrl, apiKey: API_KEY, model: "m" },
      ],
      ["POST", "/api/llm/models", { baseUrl: fake.baseUrl, apiKey: API_KEY }],
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

  it("apiKey 省略：同一 Base URL 沿用；换 Base URL → 422 LLM_API_KEY_REQUIRED（保存与列模型都一样）", async () => {
    const first = await call(app, "PUT", "/api/llm/settings", admin, {
      baseUrl: fake.baseUrl,
      model: "m",
    });
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({
      error: { code: "LLM_API_KEY_REQUIRED" },
    });

    await call(app, "PUT", "/api/llm/settings", admin, {
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
      model: "m1",
    });
    const kept = await call(app, "PUT", "/api/llm/settings", admin, {
      baseUrl: fake.baseUrl,
      model: "m2",
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ model: "m2", hasApiKey: true });

    fake.modelsScript.push({ body: { data: [{ id: "m2" }] } });
    const reuse = await call(app, "POST", "/api/llm/models", admin, {
      baseUrl: fake.baseUrl,
    });
    expect(reuse.statusCode).toBe(200);
    expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);

    for (const [method, url] of [
      ["PUT", "/api/llm/settings"],
      ["POST", "/api/llm/models"],
    ] as const) {
      const res = await call(app, method, url, admin, {
        baseUrl: "https://attacker.example/v1",
        model: "m3",
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: { code: "LLM_API_KEY_REQUIRED" },
      });
    }
    // 没有任何请求被发往别的主机，配置不变
    expect(fake.received).toHaveLength(1);
    expect(
      (await call(app, "GET", "/api/llm/settings", admin)).json(),
    ).toMatchObject({ model: "m2" });
  });

  it("上游错误码：401 → 422 LLM_UPSTREAM_UNAUTHORIZED；500 → 502 LLM_UPSTREAM_ERROR；形状错 → 400", async () => {
    fake.modelsScript.push({
      status: 401,
      body: { error: { message: `invalid key ${API_KEY}` } },
    });
    const unauthorized = await call(app, "POST", "/api/llm/models", admin, {
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
    });
    expect(unauthorized.statusCode).toBe(422);
    expect(unauthorized.json()).toMatchObject({
      error: { code: "LLM_UPSTREAM_UNAUTHORIZED" },
    });

    fake.modelsScript.push({ status: 500, body: { error: { message: "x" } } });
    const down = await call(app, "POST", "/api/llm/models", admin, {
      baseUrl: fake.baseUrl,
      apiKey: API_KEY,
    });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({
      error: { code: "LLM_UPSTREAM_ERROR" },
    });

    const bad = await call(app, "PUT", "/api/llm/settings", admin, {
      baseUrl: "not a url",
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
          baseUrl: agentSimUrl,
          adminToken: ADMIN_TOKEN,
        }),
      });
      const simAdmin = await loginAs(simApp, "admin");
      const read = await call(simApp, "GET", "/api/llm/settings", simAdmin);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({
        supported: false,
        baseUrl: null,
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
          { baseUrl: fake.baseUrl, apiKey: API_KEY, model: "m" },
        ],
        ["POST", "/api/llm/models", { baseUrl: fake.baseUrl, apiKey: API_KEY }],
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

    it("两边令牌不一致 → 502 LLM_UPSTREAM_ERROR，提示检查令牌", async () => {
      const wrong = await buildApp({
        logger: false,
        llmAdmin: createLlmAdminClient({
          baseUrl: llmAgentUrl,
          adminToken: "not-the-token",
        }),
      });
      const wrongAdmin = await loginAs(wrong, "admin");
      const res = await call(wrong, "GET", "/api/llm/settings", wrongAdmin);
      expect(res.statusCode).toBe(502);
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
