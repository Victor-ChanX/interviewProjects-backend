// 假 OpenAI 兼容服务（business-testing test.fake-external-service）：llm-agent 的上游。
// fastify listen(0)，按剧本返回、记录收到的每个请求（请求头 + 请求体）供断言次数与形状。
// - POST {baseUrl}/chat/completions：带 tools 的请求（/agent/turn、测试连接的对话）消费 turnScript，
//   不带 tools 的（/agent/audit）消费 auditScript
// - GET  {baseUrl}/models：消费 modelsScript
// 超时用 { hang: true }：请求一直挂到 app.close()（forceCloseConnections 掐断），不真睡。
// tests/llm-agent.test.ts 与 tests/llm-settings.test.ts 共用。
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import {
  AUDIT_TIMEOUT_MS,
  buildLlmAgentApp,
  type LlmAgentAppOptions,
} from "../src/llm-agent/app.js";
import type { ConfigStore } from "../src/llm-agent/config-store.js";
import { createOpenAiClient } from "../src/llm-agent/openai-client.js";

type Json = Record<string, unknown>;

export type FakeStep =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { status?: number; raw: string }
  | { hang: true };

export type FakeOpenAi = {
  app: FastifyInstance;
  /** 形如 http://127.0.0.1:<port>/v1 */
  baseUrl: string;
  turnScript: FakeStep[];
  auditScript: FakeStep[];
  modelsScript: FakeStep[];
  received: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    body: Json;
  }[];
  reset(): void;
};

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  let release = (): void => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.addHook("onClose", async () => release());
  const fake: FakeOpenAi = {
    app,
    baseUrl: "",
    turnScript: [],
    auditScript: [],
    modelsScript: [],
    received: [],
    reset() {
      this.turnScript.length = 0;
      this.auditScript.length = 0;
      this.modelsScript.length = 0;
      this.received.length = 0;
    },
  };

  const play = async (
    step: FakeStep | undefined,
    reply: { code(n: number): unknown; header(k: string, v: string): unknown },
  ): Promise<unknown> => {
    if (!step) {
      void reply.code(599);
      return { error: { message: "假 OpenAI：剧本用完了" } };
    }
    if ("hang" in step) {
      await closed;
      return "";
    }
    void reply.code(step.status ?? 200);
    if ("raw" in step) {
      void reply.header("content-type", "application/json");
      return step.raw;
    }
    for (const [k, v] of Object.entries(step.headers ?? {})) {
      void reply.header(k, v);
    }
    return step.body;
  };

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as Json;
    fake.received.push({
      method: "POST",
      url: req.url,
      headers: { ...req.headers },
      body,
    });
    const script = Array.isArray(body.tools)
      ? fake.turnScript
      : fake.auditScript;
    return play(script.shift(), reply);
  });

  app.get("/v1/models", async (req, reply) => {
    fake.received.push({
      method: "GET",
      url: req.url,
      headers: { ...req.headers },
      body: {},
    });
    return play(fake.modelsScript.shift(), reply);
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  fake.baseUrl = `${address}/v1`;
  return fake;
}

/** 一个 chat completion 响应 */
export const completion = (message: Json, finishReason = "stop"): FakeStep => ({
  body: {
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...message },
        finish_reason: finishReason,
      },
    ],
  },
});

export const toolCall = (id: string, name: string, args: unknown): Json => ({
  id,
  type: "function",
  function: {
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  },
});

export const callTools = (...calls: Json[]): FakeStep =>
  completion({ content: null, tool_calls: calls }, "tool_calls");

export const say = (content: string | null): FakeStep =>
  completion({ content });

export const verdict = (v: unknown, reason = "ok"): FakeStep =>
  completion({ content: JSON.stringify({ verdict: v, reason }) });

/** 一个临时目录里的配置文件路径（测试结束 cleanup() 删掉） */
export async function tempConfigFile(): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "llm-agent-test-"));
  return {
    filePath: join(dir, "llm-agent.json"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const ADMIN_TOKEN = "test-admin-token-0123456789";

/** 用假上游建一个 llm-agent（重试退避调到 1ms，不真等） */
export async function buildTestLlmAgent(
  opts: {
    store: ConfigStore;
    turnTimeoutMs?: number;
    maxRetries?: number;
  } & Pick<LlmAgentAppOptions, "logger">,
): Promise<FastifyInstance> {
  return buildLlmAgentApp({
    logger: opts.logger ?? false,
    store: opts.store,
    adminToken: ADMIN_TOKEN,
    upstream: createOpenAiClient({
      maxRetries: opts.maxRetries ?? 2,
      retryBaseMs: 1,
    }),
    settings: {
      turnTimeoutMs: opts.turnTimeoutMs ?? 3_000,
      auditTimeoutMs: AUDIT_TIMEOUT_MS,
      modelsTimeoutMs: 3_000,
    },
  });
}
