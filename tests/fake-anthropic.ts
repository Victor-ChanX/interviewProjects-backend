// 假 Anthropic Messages API（business-testing test.fake-external-service）：llm-agent 的 Claude 上游。
// fastify listen(0)，按剧本返回、记录收到的每个请求（请求头 + 请求体）供断言次数与形状。
// llm-agent 的官方 SDK 客户端经内部选项 testBaseURL 指到这里 —— 测试替身，不暴露给控制台。
// - POST /v1/messages：带 output_config.format 的（/agent/audit）消费 auditScript，其余（/agent/turn、测试连接）消费 turnScript
// - GET  /v1/models：消费 modelsScript
// 429 / 5xx 默认带 retry-after-ms: 1，让 SDK 的重试不真等；超时用 { hang: true }：请求挂到 app.close()，不真睡。
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

type Json = Record<string, unknown>;

export type FakeStep =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { hang: true };

export type Received = {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  body: Json;
};

export type FakeAnthropic = {
  app: FastifyInstance;
  /** 形如 http://127.0.0.1:<port> */
  url: string;
  turnScript: FakeStep[];
  auditScript: FakeStep[];
  modelsScript: FakeStep[];
  received: Received[];
  reset(): void;
};

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  let release = (): void => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.addHook("onClose", async () => release());
  const fake: FakeAnthropic = {
    app,
    url: "",
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
      void reply.code(400);
      return apiError("invalid_request_error", "假 Anthropic：剧本用完了");
    }
    if ("hang" in step) {
      await closed;
      return "";
    }
    const status = step.status ?? 200;
    void reply.code(status);
    if (status === 429 || status >= 500)
      void reply.header("retry-after-ms", "1");
    for (const [k, v] of Object.entries(step.headers ?? {})) {
      void reply.header(k, v);
    }
    return step.body;
  };

  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as Json;
    fake.received.push({
      method: "POST",
      url: req.url,
      headers: { ...req.headers },
      body,
    });
    const outputConfig = body.output_config as Json | undefined;
    const script = outputConfig?.format ? fake.auditScript : fake.turnScript;
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

  fake.url = await app.listen({ port: 0, host: "127.0.0.1" });
  return fake;
}

/** Anthropic 错误体 */
export const apiError = (type: string, message: string): Json => ({
  type: "error",
  error: { type, message },
});

/** 一个 Messages API 响应 */
export const message = (
  content: Json[],
  stopReason = "end_turn",
  extra: Json = {},
): FakeStep => ({
  body: {
    id: `msg_${randomUUID().slice(0, 8)}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  },
});

export const thinking = (signature: string): Json => ({
  type: "thinking",
  thinking: "",
  signature,
});

export const text = (value: string): Json => ({ type: "text", text: value });

export const toolUse = (id: string, name: string, input: Json): Json => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** 常见的一轮：一个（省略显示的）思考块 + 一个工具调用 */
export const callTool = (
  id: string,
  name: string,
  input: Json,
  signature = `sig-${id}`,
): FakeStep =>
  message([thinking(signature), toolUse(id, name, input)], "tool_use");

export const say = (value: string): FakeStep =>
  message([thinking("sig-say"), text(value)]);

export const verdict = (v: unknown, reason = "ok"): FakeStep =>
  message([
    thinking("sig-audit"),
    text(JSON.stringify({ verdict: v, reason })),
  ]);

/** Models API 的一项；capabilities 默认全支持本服务用到的三样 */
export const modelInfo = (
  id: string,
  caps: { adaptive?: boolean; low?: boolean; structured?: boolean } = {},
): Json => ({
  type: "model",
  id,
  display_name: `Display ${id}`,
  created_at: new Date().toISOString(),
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: caps.adaptive ?? true },
        enabled: { supported: false },
      },
    },
    effort: {
      supported: true,
      low: { supported: caps.low ?? true },
      medium: { supported: true },
      high: { supported: true },
      max: { supported: true },
      xhigh: { supported: true },
    },
    structured_outputs: { supported: caps.structured ?? true },
  },
});

export const modelsPage = (data: Json[]): FakeStep => ({
  body: {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  },
});
