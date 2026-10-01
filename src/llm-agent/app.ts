// 真实 LLM 版 Agent 服务（题目 C2）：buildLlmAgentApp(opts) 返回一个独立的 Fastify 实例，
// 对外接口与 2.2 完全相同（POST /agent/turn、POST /agent/audit），后端只改 AGENT_URL 即可从模拟器切过来。
// 上游只有题目点名的两家：Claude（anthropic.ts，官方 @anthropic-ai/sdk）与 Gemini（gemini.ts，官方 @google/genai）。
//
// 端点：
//   POST /agent/turn     2.2 的一轮：校验 → 按配置的服务商调上游（带回本 run 记住的思考状态）→ 恰好一个块
//   POST /agent/audit    审核提示词 + 结构化输出 → { verdict, reason }
//   GET  /admin/config   当前 LLM 配置（永不含 key 明文）                            ┐ 都要求请求头 x-admin-token
//   PUT  /admin/config   保存 { provider, apiKey?, model, auditModel? } 到配置文件       │ 等于 LLM_AGENT_ADMIN_TOKEN；
//   POST /admin/models   { provider, apiKey? } → 该服务商可用的模型 { items, total }     │ 由后端的 /api/llm/* 代理，
//   POST /admin/test     用已保存的配置跑一轮带工具历史的 turn + 一次 audit             ┘ 控制台不直连本服务
//   GET  /health
//
// 上游配置只来自控制台保存的配置文件（config-store.ts），每个请求重新读，保存后不用重启；没配置时 /agent/turn、
// /agent/audit 回 503（后端分别按协议错误 / 审计拿不到结论处理）。
// 会话状态（题目 2.2：「Agent 服务按 runId 维护会话状态」）：每轮把上游返回的完整 assistant 回合按 runId + tool_use.id
// 记进 session-store.ts，下一轮换回去 —— 两家上游都要求多轮工具调用原样带回思考状态。run 以 finish / end_turn 结束时清掉。
// 与 src/sim/* 同级：不 import src/db、src/services。
import { createHash, timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import {
  PROVIDERS,
  toView,
  type ConfigStore,
  type LlmTarget,
  type LoadedLlmConfig,
  type Provider,
} from "./config-store.js";
import {
  AuditRequest,
  TurnRequest,
  validateTools,
  type AgentMessage,
  type AgentTool,
} from "./protocol.js";
import type { SessionStore, StoredTurn } from "./session-store.js";
import { UpstreamError, type LlmClient } from "./upstream.js";

/** 一次 /agent/audit 调上游的总预算：要比后端的 AGENT_AUDIT_TIMEOUT_MS（默认 5s）小 1 秒 */
export const AUDIT_TIMEOUT_MS = 4_000;
/** 控制台「获取模型列表」调上游的超时 */
export const MODELS_TIMEOUT_MS = 10_000;

export type LlmAgentSettings = {
  /** 一次 /agent/turn 调上游的总预算（含重试），必须小于后端的 AGENT_TURN_TIMEOUT_MS */
  turnTimeoutMs: number;
  auditTimeoutMs: number;
  modelsTimeoutMs: number;
};

export type LlmAgentAppOptions = {
  /** 每个服务商一个上游客户端（main.ts 建官方端点的；测试指向假服务） */
  clients: Readonly<Record<Provider, LlmClient>>;
  store: ConfigStore;
  sessions: SessionStore;
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
  | "LLM_CONFIG_INVALID"
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
  "尚未配置 LLM：请先在控制台『模型设置』里选服务商（Claude / Gemini）、填 API Key 并选择模型";

const PROVIDER_LABEL: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: "Claude",
  gemini: "Gemini",
});

const ProviderField = z.enum(PROVIDERS);

const ConfigUpdate = z.object({
  provider: ProviderField,
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  auditModel: z.string().trim().min(1).nullable().optional(),
});

const ModelsRequest = z.object({
  provider: ProviderField,
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
 * 请求里没带 apiKey 时沿用已存的 key —— 仅当服务商与已存的相同：一家的 key 对另一家没有意义，
 * 也不该被发到另一家的端点。
 */
async function resolveApiKey(
  provider: Provider,
  apiKey: string | undefined,
  current: () => Promise<LoadedLlmConfig>,
): Promise<string> {
  // 带了 key 就不读已存的配置：旧文件格式不对时，控制台带 key 重新保存一次就能覆盖
  if (apiKey) return apiKey;
  const loaded = await current();
  if (loaded.apiKey && loaded.provider === provider) return loaded.apiKey;
  throw new LlmAgentError(
    422,
    "LLM_API_KEY_REQUIRED",
    "请填写 API Key：只有服务商与已保存的相同时才能沿用已保存的 Key",
  );
}

/** 两个令牌定长比较（先各自哈希成 32 字节），不因长度或前缀泄露信息 */
function sameToken(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 「测试连接」的 turn：带一轮（没有思考状态的）工具调用历史，和「记不到」时的真实第二轮同形 */
const PROBE_TOOLS: readonly AgentTool[] = Object.freeze([
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
const PROBE_MESSAGES: readonly AgentMessage[] = Object.freeze([
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

const elapsedSince = (start: number): number =>
  Math.round(performance.now() - start);

export async function buildLlmAgentApp(
  opts: LlmAgentAppOptions,
): Promise<FastifyInstance> {
  const { clients, store, sessions, settings } = opts;
  const app = Fastify({
    logger: opts.logger ?? true,
    exposeHeadRoutes: false,
    // 第一条 user 消息可能带触发消息的图片（后端 #61，base64），默认 1 MB 的请求体上限不够
    bodyLimit: 16 * 1024 * 1024,
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

  /** 读配置；文件格式不对 → 500 LLM_CONFIG_INVALID（文案告诉人怎么修，后端原样转给控制台） */
  const loadConfig = async (): Promise<LoadedLlmConfig> => {
    try {
      return await store.load();
    } catch (err) {
      throw new LlmAgentError(
        500,
        "LLM_CONFIG_INVALID",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  /** 当前可用的上游配置；没配置 → 503 */
  const currentTarget = async (): Promise<LlmTarget> => {
    const loaded = await loadConfig();
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
    const log = req.log.child({ runId, provider: target.provider });

    // 会话状态读失败不让本轮失败：按「全部记不到」处理（各上游有各自的安全降级）
    let remembered: ReadonlyMap<string, StoredTurn> = new Map();
    try {
      remembered = await sessions.load(runId);
    } catch (err) {
      log.warn({ err }, "读会话状态失败，本轮按没有记忆处理");
    }
    const recall = (toolUseId: string): unknown => {
      const turn = remembered.get(toolUseId);
      return turn &&
        turn.provider === target.provider &&
        turn.model === target.model
        ? turn.content
        : undefined;
    };

    const startedAt = performance.now();
    let result;
    try {
      result = await clients[target.provider].turn(
        {
          apiKey: target.apiKey,
          model: target.model,
          tools: tools as AgentTool[],
          messages,
          recall,
        },
        { timeoutMs: settings.turnTimeoutMs },
      );
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      // 502：后端把非 2xx 记为 BAD_JSON 协议错误、追加 PROTOCOL_ERROR 文本后继续（2.2 / A5 第 3 条的语义）
      log.warn(
        { status: err.status, elapsedMs: elapsedSince(startedAt) },
        `上游失败：${err.message}`,
      );
      throw new LlmAgentError(502, "UPSTREAM_ERROR", err.message, {
        upstreamStatus: err.status,
      });
    }

    const block = result.response.content[0];
    try {
      if (block.type === "tool_use" && block.name !== "finish") {
        await sessions.remember(runId, block.id, {
          provider: target.provider,
          model: target.model,
          content: result.replay,
        });
      } else {
        // finish / end_turn：后端不会再为这个 run 调 /agent/turn
        await sessions.forget(runId);
      }
    } catch (err) {
      log.warn({ err }, "写会话状态失败，下一轮按记不到处理");
    }
    log.info(
      {
        model: target.model,
        servedBy: result.servedBy,
        stopReason: result.response.stop_reason,
        tool: block.type === "tool_use" ? block.name : null,
        elapsedMs: elapsedSince(startedAt),
      },
      "agent turn",
    );
    return result.response;
  });

  app.post("/agent/audit", async (req) => {
    const { text, groupId } = parseBody(AuditRequest, req.body);
    const target = await currentTarget();
    const model = target.auditModel ?? target.model;
    const startedAt = performance.now();
    try {
      const result = await clients[target.provider].audit(
        { apiKey: target.apiKey, model, text, groupId },
        { timeoutMs: settings.auditTimeoutMs },
      );
      req.log.info(
        {
          groupId,
          model,
          verdict: result.verdict,
          elapsedMs: elapsedSince(startedAt),
        },
        "agent audit",
      );
      return result;
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      // 500：后端对同一次工具调用最多重试 3 次，都拿不到结论就把 run 置 blocked（2.2 / A5 第 4 条）
      req.log.warn(
        {
          groupId,
          model,
          status: err.status,
          elapsedMs: elapsedSince(startedAt),
        },
        `审计没有拿到结论：${err.message}`,
      );
      throw new LlmAgentError(500, "AUDIT_UNAVAILABLE", err.message);
    }
  });

  // ---- 管理端点（后端 /api/llm/* 代理）------------------------------------------------------

  app.get("/admin/config", { preHandler: [requireAdmin] }, async () =>
    toView(await loadConfig()),
  );

  app.put("/admin/config", { preHandler: [requireAdmin] }, async (req) => {
    const input = parseBody(ConfigUpdate, req.body);
    const apiKey = await resolveApiKey(
      input.provider,
      input.apiKey,
      loadConfig,
    );
    const saved = await store.save({
      provider: input.provider,
      apiKey,
      model: input.model,
      auditModel: input.auditModel ?? null,
    });
    req.log.info(
      {
        provider: saved.provider,
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
    const apiKey = await resolveApiKey(
      input.provider,
      input.apiKey,
      loadConfig,
    );
    try {
      const items = await clients[input.provider].listModels(apiKey, {
        timeoutMs: settings.modelsTimeoutMs,
      });
      return { items, total: items.length };
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      req.log.warn(
        { provider: input.provider, status: err.status },
        `获取模型列表失败：${err.message}`,
      );
      if (err.keyRejected) {
        throw new LlmAgentError(
          422,
          "LLM_UPSTREAM_UNAUTHORIZED",
          `${PROVIDER_LABEL[input.provider]} 拒绝了这个 API Key（HTTP ${err.status ?? "?"}），检查 Key 是否正确、是否属于这个服务商`,
        );
      }
      throw new LlmAgentError(
        502,
        "LLM_UPSTREAM_ERROR",
        `获取模型列表失败：${err.message}`,
      );
    }
  });

  app.post("/admin/test", { preHandler: [requireAdmin] }, async (req) => {
    const target = (await loadConfig()).usable;
    if (!target) {
      return {
        ok: false,
        latencyMs: 0,
        model: null,
        message: NOT_CONFIGURED_MESSAGE,
      };
    }
    const client = clients[target.provider];
    const startedAt = performance.now();
    try {
      await client.turn(
        {
          apiKey: target.apiKey,
          model: target.model,
          tools: PROBE_TOOLS,
          messages: PROBE_MESSAGES,
          recall: () => undefined,
        },
        { timeoutMs: settings.turnTimeoutMs },
      );
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      const message = `对话（带工具调用历史）失败：${err.message}`;
      req.log.warn({ model: target.model }, `测试连接失败：${message}`);
      return {
        ok: false,
        latencyMs: elapsedSince(startedAt),
        model: target.model,
        message,
      };
    }
    const auditModel = target.auditModel ?? target.model;
    let message: string;
    let ok: boolean;
    try {
      const verdict = await client.audit(
        {
          apiKey: target.apiKey,
          model: auditModel,
          text: "大家好，欢迎新朋友！",
          groupId: "connection-test",
        },
        { timeoutMs: settings.auditTimeoutMs },
      );
      ok = true;
      message = `连接正常：${PROVIDER_LABEL[target.provider]} 模型 ${target.model} 能处理工具调用，审计模型 ${auditModel} 返回了 ${verdict.verdict}`;
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      ok = false;
      message = `对话正常，但审计（结构化输出）失败：${err.message}`;
    }
    const latencyMs = elapsedSince(startedAt);
    req.log.info({ model: target.model, ok, latencyMs }, "测试连接完成");
    return { ok, latencyMs, model: target.model, message };
  });

  return app;
}
