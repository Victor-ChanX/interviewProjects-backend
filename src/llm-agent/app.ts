// 真实 LLM 版 Agent 服务（题目 C2）：buildLlmAgentApp(opts) 返回一个独立的 Fastify 实例，
// 对外接口与 2.2 完全相同（POST /agent/turn、POST /agent/audit），后端只改 AGENT_URL 即可从模拟器切过来。
//
// 端点：
//   POST /agent/turn     2.2 的一轮：校验 → Anthropic 形状翻成 OpenAI → 调上游 → 翻回恰好一个块
//   POST /agent/audit    审核提示词 + 上游模型 → { verdict, reason }
//   GET  /admin/config   当前 LLM 配置（永不含 key 明文）                       ┐ 都要求请求头 x-admin-token
//   PUT  /admin/config   保存 { baseUrl, apiKey?, model, auditModel? } 到配置文件  │ 等于 LLM_AGENT_ADMIN_TOKEN；
//   POST /admin/models   调 {baseUrl}/models 列出模型                             │ 由后端的 /api/llm/* 代理，
//   POST /admin/test     用已保存的配置跑一轮带工具历史的 turn + 一次 audit        ┘ 控制台不直连本服务
//   GET  /health
//
// 上游配置（base url / key / 模型）只来自控制台保存的配置文件（config-store.ts），每个请求重新读，保存后不用重启；
// 没配置时 /agent/turn、/agent/audit 回 503（后端分别按协议错误 / 审计拿不到结论处理）。
// 不存会话状态：后端每轮都把完整历史传过来（runId 只进日志）。与 src/sim/* 同级：不 import src/db、src/services。
import { createHash, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { runAudit } from "./audit.js";
import {
  normalizeBaseUrl,
  toView,
  type ConfigStore,
  type LlmTarget,
  type LoadedLlmConfig,
} from "./config-store.js";
import type { ChatClient } from "./openai-client.js";
import { TURN_SYSTEM_PROMPT } from "./prompts.js";
import { providerParams } from "./providers.js";
import {
  AuditRequest,
  TurnRequest,
  fromOpenAiCompletion,
  historyToolUseIds,
  toOpenAiMessages,
  toOpenAiTools,
  validateTools,
  type AnthropicMessage,
  type AnthropicTool,
} from "./translate.js";

/** 一次 /agent/audit 调上游的总预算：要比后端的 AGENT_AUDIT_TIMEOUT_MS（默认 5s）小 1 秒 */
export const AUDIT_TIMEOUT_MS = 4_000;
/** 控制台「获取模型列表」调上游 /models 的超时 */
export const MODELS_TIMEOUT_MS = 10_000;

export type LlmAgentSettings = {
  /** 一次 /agent/turn 调上游的总预算（含重试），必须小于后端的 AGENT_TURN_TIMEOUT_MS */
  turnTimeoutMs: number;
  auditTimeoutMs: number;
  modelsTimeoutMs: number;
};

export type LlmAgentAppOptions = {
  upstream: ChatClient;
  store: ConfigStore;
  settings: LlmAgentSettings;
  /** /admin/* 的令牌（LLM_AGENT_ADMIN_TOKEN） */
  adminToken: string;
  /** false 给测试用；测试也可以传 { stream } 收集日志，断言 key 不出现 */
  logger?: boolean | { level?: string; stream: { write(msg: string): void } };
};

type LlmAgentErrorCode =
  | "VALIDATION_ERROR"
  | "TOOLS_INVALID"
  | "UNAUTHORIZED"
  | "UPSTREAM_ERROR"
  | "LLM_NOT_CONFIGURED"
  | "AUDIT_UNAVAILABLE"
  | "LLM_API_KEY_REQUIRED"
  | "LLM_UPSTREAM_UNAUTHORIZED"
  | "LLM_UPSTREAM_ERROR"
  | "INTERNAL";

/** 错误信封与应用、模拟器同形：{ error: { code, message, requestId, ...extra } } */
class LlmAgentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: LlmAgentErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LlmAgentError";
  }
}

const NOT_CONFIGURED_MESSAGE =
  "尚未配置 LLM：请先在控制台『模型设置』里填 Base URL、API Key 并选择模型";

const HttpUrl = z.url({ protocol: /^https?$/ });

const ConfigUpdate = z.object({
  baseUrl: HttpUrl,
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  auditModel: z.string().trim().min(1).nullable().optional(),
});

const ModelsRequest = z.object({
  baseUrl: HttpUrl,
  apiKey: z.string().trim().min(1).optional(),
});

const issuesOf = (error: z.ZodError): { path: string; message: string }[] =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new LlmAgentError(400, "VALIDATION_ERROR", "请求体不合法", {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
}

/**
 * 请求里没带 apiKey 时沿用已存的 key —— 仅当 baseUrl 与已存的相同：否则等于把已存的 key 发给另一个主机
 * （例如有人把 Base URL 改成自己的服务器来套 key）。
 */
function resolveApiKey(
  baseUrl: string,
  apiKey: string | undefined,
  current: LoadedLlmConfig,
): string {
  if (apiKey) return apiKey;
  if (
    current.apiKey &&
    current.baseUrl &&
    normalizeBaseUrl(current.baseUrl) === normalizeBaseUrl(baseUrl)
  ) {
    return current.apiKey;
  }
  throw new LlmAgentError(
    422,
    "LLM_API_KEY_REQUIRED",
    "请填写 API Key：只有 Base URL 与已保存的相同时才能沿用已保存的 Key",
  );
}

/** 两个令牌定长比较（先各自哈希成 32 字节），不因长度或前缀泄露信息 */
function sameToken(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** /agent/turn 的上游请求体（导出给测试） */
export function turnRequestBody(
  input: {
    tools: readonly AnthropicTool[];
    messages: readonly AnthropicMessage[];
  },
  target: LlmTarget,
): Record<string, unknown> {
  return {
    model: target.model,
    messages: toOpenAiMessages(input.messages, TURN_SYSTEM_PROMPT),
    tools: toOpenAiTools(input.tools),
    tool_choice: "auto",
    ...providerParams(target.baseUrl, target.model),
  };
}

/** 「测试连接」的 turn：带一轮工具调用历史，和真实的第二轮同形 —— 要求回传思考内容的模型在这里就会失败 */
const PROBE_TOOLS: readonly AnthropicTool[] = Object.freeze([
  {
    name: "ping",
    description: "连通性检查工具。",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
]);
const PROBE_MESSAGES: readonly AnthropicMessage[] = Object.freeze([
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "这是一次连接测试：已经调用过 ping，现在用一句话回复「连接正常」。",
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_probe_1",
        name: "ping",
        input: { note: "hi" },
      },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call_probe_1",
        content: '{"pong":true}',
      },
    ],
  },
]);

export async function buildLlmAgentApp(
  opts: LlmAgentAppOptions,
): Promise<FastifyInstance> {
  const { upstream, store, settings } = opts;
  const app = Fastify({
    logger: opts.logger ?? true,
    exposeHeadRoutes: false,
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof LlmAgentError) {
      void reply.code(err.statusCode).send({
        error: {
          ...err.extra,
          code: err.code,
          message: err.message,
          requestId,
        },
      });
      return;
    }
    const known = err as { statusCode?: unknown; message?: unknown };
    const statusCode =
      typeof known.statusCode === "number" && known.statusCode >= 400
        ? known.statusCode
        : 500;
    if (statusCode >= 500) req.log.error({ err, requestId }, "未处理的异常");
    void reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL" : "VALIDATION_ERROR",
        message:
          statusCode >= 500 || typeof known.message !== "string"
            ? "Agent 服务内部错误"
            : known.message,
        requestId,
      },
    });
  });

  const requireAdmin = async (req: FastifyRequest): Promise<void> => {
    const header = req.headers["x-admin-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !sameToken(token, opts.adminToken)) {
      throw new LlmAgentError(
        401,
        "UNAUTHORIZED",
        "管理令牌不对：请求头 x-admin-token 要等于 LLM_AGENT_ADMIN_TOKEN",
      );
    }
  };

  /** 当前可用的上游配置；没配置 → 503 */
  const currentTarget = async (): Promise<LlmTarget> => {
    const loaded = await store.load();
    if (!loaded.usable) {
      throw new LlmAgentError(
        503,
        "LLM_NOT_CONFIGURED",
        NOT_CONFIGURED_MESSAGE,
      );
    }
    return loaded.usable;
  };

  app.get("/health", async () => ({ status: "ok" }));

  // ---- 2.2 协议 --------------------------------------------------------------------------

  app.post("/agent/turn", async (req) => {
    const { runId, tools, messages } = parseBody(TurnRequest, req.body);
    const toolIssues = validateTools(tools);
    if (toolIssues.length > 0) {
      throw new LlmAgentError(
        400,
        "TOOLS_INVALID",
        "tools 必须恰好是题目规定的 4 个工具，且 input_schema 合法、required 覆盖全部入参",
        { issues: toolIssues },
      );
    }
    const target = await currentTarget();
    const history = messages as AnthropicMessage[];
    const outcome = await upstream.chat(
      target,
      turnRequestBody(
        { tools: tools as AnthropicTool[], messages: history },
        target,
      ),
      { timeoutMs: settings.turnTimeoutMs },
    );
    if (!outcome.ok) {
      // 502：后端把非 2xx 记为 BAD_JSON 协议错误、追加 PROTOCOL_ERROR 文本后继续（2.2 / A5 第 3 条的语义）
      req.log.warn(
        {
          runId,
          status: outcome.status,
          attempts: outcome.attempts,
          elapsedMs: outcome.elapsedMs,
        },
        `上游失败：${outcome.reason}`,
      );
      throw new LlmAgentError(502, "UPSTREAM_ERROR", outcome.reason, {
        upstreamStatus: outcome.status,
        attempts: outcome.attempts,
      });
    }
    const response = fromOpenAiCompletion(
      outcome.completion,
      historyToolUseIds(history),
    );
    if (!response) {
      req.log.warn(
        { runId, attempts: outcome.attempts },
        "上游响应缺少 choices[0].message",
      );
      throw new LlmAgentError(
        502,
        "UPSTREAM_ERROR",
        "上游响应不是 chat completion 形状（缺少 choices[0].message）",
      );
    }
    const block = response.content[0];
    req.log.info(
      {
        runId,
        model: target.model,
        stopReason: response.stop_reason,
        tool: block.type === "tool_use" ? block.name : null,
        attempts: outcome.attempts,
        elapsedMs: outcome.elapsedMs,
      },
      "agent turn",
    );
    return response;
  });

  app.post("/agent/audit", async (req) => {
    const { text, groupId } = parseBody(AuditRequest, req.body);
    const target = await currentTarget();
    const outcome = await runAudit(
      { text, groupId },
      target,
      upstream,
      settings.auditTimeoutMs,
    );
    if (!outcome.ok) {
      // 500：后端对同一次工具调用最多重试 3 次，都拿不到结论就把 run 置 blocked（2.2 / A5 第 4 条）
      req.log.warn(
        { groupId, attempts: outcome.attempts, elapsedMs: outcome.elapsedMs },
        `审计没有拿到结论：${outcome.reason}`,
      );
      throw new LlmAgentError(500, "AUDIT_UNAVAILABLE", outcome.reason);
    }
    req.log.info(
      {
        groupId,
        verdict: outcome.result.verdict,
        attempts: outcome.attempts,
        elapsedMs: outcome.elapsedMs,
      },
      "agent audit",
    );
    return outcome.result;
  });

  // ---- 管理端点（后端 /api/llm/* 代理）------------------------------------------------------

  app.get("/admin/config", { preHandler: [requireAdmin] }, async () =>
    toView(await store.load()),
  );

  app.put("/admin/config", { preHandler: [requireAdmin] }, async (req) => {
    const input = parseBody(ConfigUpdate, req.body);
    const current = await store.load();
    const apiKey = resolveApiKey(input.baseUrl, input.apiKey, current);
    const saved = await store.save({
      baseUrl: input.baseUrl,
      apiKey,
      model: input.model,
      auditModel: input.auditModel ?? null,
    });
    req.log.info(
      {
        baseUrl: saved.baseUrl,
        model: saved.model,
        auditModel: saved.auditModel,
        apiKeyChanged: input.apiKey !== undefined,
      },
      "LLM 配置已保存",
    );
    return toView(saved);
  });

  app.post("/admin/models", { preHandler: [requireAdmin] }, async (req) => {
    const input = parseBody(ModelsRequest, req.body);
    const apiKey = resolveApiKey(
      input.baseUrl,
      input.apiKey,
      await store.load(),
    );
    const outcome = await upstream.listModels(
      { baseUrl: input.baseUrl, apiKey },
      { timeoutMs: settings.modelsTimeoutMs },
    );
    if (!outcome.ok) {
      req.log.warn(
        { baseUrl: normalizeBaseUrl(input.baseUrl), status: outcome.status },
        `获取模型列表失败：${outcome.reason}`,
      );
      if (outcome.status === 401 || outcome.status === 403) {
        throw new LlmAgentError(
          422,
          "LLM_UPSTREAM_UNAUTHORIZED",
          `服务商拒绝了这个 API Key（HTTP ${outcome.status}），检查 Key 是否正确、是否属于这个 Base URL`,
        );
      }
      throw new LlmAgentError(
        502,
        "LLM_UPSTREAM_ERROR",
        `获取模型列表失败：${outcome.reason}`,
      );
    }
    return { models: outcome.models };
  });

  app.post("/admin/test", { preHandler: [requireAdmin] }, async (req) => {
    const loaded = await store.load();
    const target = loaded.usable;
    if (!target) {
      return {
        ok: false,
        latencyMs: 0,
        model: null,
        message: NOT_CONFIGURED_MESSAGE,
      };
    }
    const turn = await upstream.chat(
      target,
      turnRequestBody({ tools: PROBE_TOOLS, messages: PROBE_MESSAGES }, target),
      { timeoutMs: settings.turnTimeoutMs },
    );
    const turnShapeOk =
      turn.ok && fromOpenAiCompletion(turn.completion, new Set()) !== null;
    if (!turnShapeOk) {
      const message = turn.ok
        ? "对话接口返回的不是 chat completion 形状"
        : `对话（带工具调用历史）失败：${turn.reason}`;
      req.log.warn({ model: target.model }, `测试连接失败：${message}`);
      return {
        ok: false,
        latencyMs: turn.elapsedMs,
        model: target.model,
        message,
      };
    }
    const audit = await runAudit(
      { text: "大家好，欢迎新朋友！", groupId: "connection-test" },
      target,
      upstream,
      settings.auditTimeoutMs,
    );
    const latencyMs = turn.elapsedMs + audit.elapsedMs;
    const message = audit.ok
      ? `连接正常：模型 ${target.model} 能处理工具调用，审计模型 ${target.auditModel ?? target.model} 返回了 ${audit.result.verdict}`
      : `对话正常，但审计（JSON 输出）失败：${audit.reason}`;
    req.log.info(
      { model: target.model, ok: audit.ok, latencyMs },
      "测试连接完成",
    );
    return { ok: audit.ok, latencyMs, model: target.model, message };
  });

  return app;
}
