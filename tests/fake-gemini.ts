// 假 Gemini API（business-testing test.fake-external-service）：llm-agent 的 Gemini 上游。
// fastify listen(0)，按剧本返回、记录收到的每个请求（请求头 + 请求体）供断言次数与形状。
// llm-agent 的官方 @google/genai 客户端经内部选项 testBaseUrl（SDK 的 httpOptions.baseUrl）指到这里 —— 测试替身，
// 不暴露给控制台。
// - POST /v1beta/models/<model>:generateContent：generationConfig.responseMimeType 为 application/json 的
//   （/agent/audit）消费 auditScript，其余消费 turnScript
// - GET  /v1beta/models：消费 modelsScript
// 超时用 { hang: true }：请求挂到 app.close()，不真睡。
import Fastify, { type FastifyInstance } from "fastify";

import type { FakeStep, Received } from "./fake-anthropic.js";

type Json = Record<string, unknown>;

export type FakeGemini = {
  app: FastifyInstance;
  /** 形如 http://127.0.0.1:<port> */
  url: string;
  turnScript: FakeStep[];
  auditScript: FakeStep[];
  modelsScript: FakeStep[];
  received: Received[];
  reset(): void;
};

export async function startFakeGemini(): Promise<FakeGemini> {
  let release = (): void => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 真上游收得下几十 MB（带图片的请求，后端 #61）；默认 1 MB 会把大请求拒成 413
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: 32 * 1024 * 1024,
  });
  app.addHook("onClose", async () => release());
  const fake: FakeGemini = {
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
      return geminiError(400, "INVALID_ARGUMENT", "假 Gemini：剧本用完了");
    }
    if ("hang" in step) {
      await closed;
      return "";
    }
    void reply.code(step.status ?? 200);
    for (const [k, v] of Object.entries(step.headers ?? {})) {
      void reply.header(k, v);
    }
    return step.body;
  };

  app.post("/v1beta/models/:action", async (req, reply) => {
    const body = req.body as Json;
    fake.received.push({
      method: "POST",
      url: req.url,
      headers: { ...req.headers },
      body,
    });
    const generation = body.generationConfig as Json | undefined;
    const script =
      generation?.responseMimeType === "application/json"
        ? fake.auditScript
        : fake.turnScript;
    return play(script.shift(), reply);
  });

  app.get("/v1beta/models", async (req, reply) => {
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

/** Google API 错误体 */
export const geminiError = (
  code: number,
  status: string,
  message: string,
): Json => ({ error: { code, message, status } });

/** 一个 generateContent 响应（一个候选） */
export const candidate = (parts: Json[], finishReason = "STOP"): FakeStep => ({
  body: {
    candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
    modelVersion: "gemini-3-flash-preview",
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  },
});

export const functionCall = (
  name: string,
  args: Json,
  opts: { id?: string; signature?: string } = {},
): Json => ({
  functionCall: { ...(opts.id ? { id: opts.id } : {}), name, args },
  ...(opts.signature ? { thoughtSignature: opts.signature } : {}),
});

export const say = (value: string): FakeStep =>
  candidate([{ text: "（思考摘要）", thought: true }, { text: value }]);

export const verdict = (v: unknown, reason = "ok"): FakeStep =>
  candidate([{ text: JSON.stringify({ verdict: v, reason }) }]);

export const modelsPage = (
  models: { name: string; displayName?: string; methods: string[] }[],
): FakeStep => ({
  body: {
    models: models.map((m) => ({
      name: m.name,
      ...(m.displayName ? { displayName: m.displayName } : {}),
      supportedGenerationMethods: m.methods,
    })),
  },
});
