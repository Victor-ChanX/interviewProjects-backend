// LLM 设置（#19，题目 C2）：控制台 → 后端 /api/llm/* → llm-agent 的 /admin/*。
//
// 这是后端**唯一**知道 llm-agent 存在的地方：它就是 AGENT_URL 指向的那个服务，只是多了管理端点（请求头
// x-admin-token = LLM_AGENT_ADMIN_TOKEN）。AGENT_URL 指向 Agent 模拟器时对方没有 /admin/*（404）→ 读返回
// supported=false，写 / 列模型 / 测试 → 409 LLM_AGENT_UNSUPPORTED。后端没配令牌同样按「不支持」处理。
//
// 服务商只有题目 C2 点名的 Claude（anthropic）与 Gemini（gemini），llm-agent 用各自官方 SDK 调官方端点。
// 后端不存任何 LLM 配置、不碰库：配置文件在 llm-agent 那边（含 key）。API key 只进不出 —— 请求体里的 apiKey
// 原样转给 llm-agent，响应里只有 hasApiKey + apiKeyHint；这里的日志与错误文案都不含 key。
// 用全局 fetch（tests/setup.ts 的 MockAgent 只接管它）；测试经 buildApp({ llmAdmin }) 注入指向本地实例的客户端。
import { config } from "../core/config.js";
import {
  BadGateway,
  Conflict,
  Invalid,
  type ErrorCode,
} from "../core/errors.js";

export type LlmProvider = "anthropic" | "gemini";

export type LlmConfigView = {
  provider: LlmProvider | null;
  model: string | null;
  auditModel: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  updatedAt: string | null;
  source: "file" | "none";
};

/** supported=false 时其余字段为 null / false（source 也是 null） */
export type LlmSettings = Omit<LlmConfigView, "source"> & {
  supported: boolean;
  source: LlmConfigView["source"] | null;
};

export type LlmModel = { id: string; displayName: string };

export type LlmTestOutcome = {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  message: string;
};

type AdminResponse =
  | { kind: "ok"; body: unknown }
  | { kind: "unsupported" }
  | {
      kind: "error";
      status: number | null;
      code: string | null;
      message: string;
    };

export type LlmAdminClient = {
  request(
    method: "GET" | "PUT" | "POST",
    path: string,
    body?: unknown,
  ): Promise<AdminResponse>;
};

/**
 * 调 llm-agent 管理端点的超时：/admin/test 在对方要跑一轮 turn（≤ LLM_TIMEOUT_MS，默认 10s）+ 一次 audit（≤ 4s），
 * 所以这里给 20 秒；其余端点远用不到。
 */
export const LLM_ADMIN_TIMEOUT_MS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createLlmAdminClient(opts: {
  agentUrl: string;
  adminToken: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): LlmAdminClient {
  const agentUrl = opts.agentUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LLM_ADMIN_TIMEOUT_MS;
  return {
    async request(method, path, body) {
      let res: Response;
      let raw: string;
      try {
        res = await fetchImpl(`${agentUrl}${path}`, {
          method,
          headers: {
            "x-admin-token": opts.adminToken,
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        raw = await res.text();
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name;
        return {
          kind: "error",
          status: null,
          code: null,
          message:
            name === "TimeoutError" || name === "AbortError"
              ? `llm-agent 在 ${timeoutMs}ms 内没有响应`
              : "连不上 llm-agent（AGENT_URL），确认它已启动",
        };
      }
      // 没有这个端点 = 对方不是 llm-agent（Agent 模拟器之类）
      if (res.status === 404 || res.status === 405)
        return { kind: "unsupported" };
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 下面按非 JSON 处理
      }
      if (res.ok) {
        return parsed === null
          ? {
              kind: "error",
              status: res.status,
              code: null,
              message: "llm-agent 的响应不是合法 JSON",
            }
          : { kind: "ok", body: parsed };
      }
      const error =
        isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
      return {
        kind: "error",
        status: res.status,
        code: typeof error?.code === "string" ? error.code : null,
        message:
          typeof error?.message === "string"
            ? error.message
            : `llm-agent 返回 HTTP ${res.status}`,
      };
    },
  };
}

/** 生产用：AGENT_URL + LLM_AGENT_ADMIN_TOKEN；任一缺失返回 null（= 不支持） */
export function llmAdminClientFromConfig(): LlmAdminClient | null {
  if (!config.agentUrl || !config.llmAgentAdminToken) return null;
  return createLlmAdminClient({
    agentUrl: config.agentUrl,
    adminToken: config.llmAgentAdminToken,
  });
}

const UNSUPPORTED_MESSAGE =
  "当前的 Agent 服务不支持模型设置：把 AGENT_URL 指向 llm-agent（npm run llm-agent），并在后端与 llm-agent 配同一个 LLM_AGENT_ADMIN_TOKEN";

const UNSUPPORTED_READ: LlmSettings = Object.freeze({
  supported: false,
  provider: null,
  model: null,
  auditModel: null,
  hasApiKey: false,
  apiKeyHint: null,
  updatedAt: null,
  source: null,
});

/** llm-agent 自己的错误码中可以原样转给前端的（语义与后端 ErrorCode 相同） */
const PASS_THROUGH_422: readonly ErrorCode[] = Object.freeze([
  "LLM_API_KEY_REQUIRED",
  "LLM_UPSTREAM_UNAUTHORIZED",
]);

/** 非 ok 的管理端点响应 → 领域异常 */
function toDomainError(res: Exclude<AdminResponse, { kind: "ok" }>): Error {
  if (res.kind === "unsupported") {
    return new Conflict("LLM_AGENT_UNSUPPORTED", UNSUPPORTED_MESSAGE);
  }
  if (res.code && (PASS_THROUGH_422 as readonly string[]).includes(res.code)) {
    return new Invalid(res.code as ErrorCode, res.message);
  }
  if (res.status === 401) {
    return new BadGateway(
      "LLM_UPSTREAM_ERROR",
      "llm-agent 拒绝了管理令牌：后端与 llm-agent 的 LLM_AGENT_ADMIN_TOKEN 要一致",
    );
  }
  if (res.status === 400) {
    return new Invalid("VALIDATION_ERROR", res.message);
  }
  return new BadGateway("LLM_UPSTREAM_ERROR", res.message);
}

const isProvider = (v: unknown): v is LlmProvider =>
  v === "anthropic" || v === "gemini";

/** llm-agent 的 /admin/config 响应 → LlmConfigView（形状不对按 502：对方版本不匹配） */
function toView(body: unknown): LlmConfigView {
  const nullableString = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  if (
    !isRecord(body) ||
    (body.source !== "file" && body.source !== "none") ||
    (body.provider !== null && !isProvider(body.provider))
  ) {
    throw new BadGateway(
      "LLM_UPSTREAM_ERROR",
      "llm-agent 返回的配置形状不对，确认两边是同一版本",
    );
  }
  return {
    provider: isProvider(body.provider) ? body.provider : null,
    model: nullableString(body.model),
    auditModel: nullableString(body.auditModel),
    hasApiKey: body.hasApiKey === true,
    apiKeyHint: nullableString(body.apiKeyHint),
    updatedAt: nullableString(body.updatedAt),
    source: body.source,
  };
}

export async function getLlmSettings(
  client: LlmAdminClient | null,
): Promise<LlmSettings> {
  if (!client) return { ...UNSUPPORTED_READ };
  const res = await client.request("GET", "/admin/config");
  if (res.kind === "unsupported") return { ...UNSUPPORTED_READ };
  if (res.kind !== "ok") throw toDomainError(res);
  return { supported: true, ...toView(res.body) };
}

export async function saveLlmSettings(
  client: LlmAdminClient | null,
  input: {
    provider: LlmProvider;
    apiKey?: string | undefined;
    model: string;
    auditModel?: string | null | undefined;
  },
): Promise<LlmSettings> {
  if (!client) throw toDomainError({ kind: "unsupported" });
  const res = await client.request("PUT", "/admin/config", {
    provider: input.provider,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    model: input.model,
    auditModel: input.auditModel ?? null,
  });
  if (res.kind !== "ok") throw toDomainError(res);
  return { supported: true, ...toView(res.body) };
}

export async function listLlmModels(
  client: LlmAdminClient | null,
  input: { provider: LlmProvider; apiKey?: string | undefined },
): Promise<{ items: LlmModel[]; total: number }> {
  if (!client) throw toDomainError({ kind: "unsupported" });
  const res = await client.request("POST", "/admin/models", {
    provider: input.provider,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
  });
  if (res.kind !== "ok") throw toDomainError(res);
  const models =
    isRecord(res.body) && Array.isArray(res.body.items) ? res.body.items : null;
  if (!models) {
    throw new BadGateway(
      "LLM_UPSTREAM_ERROR",
      "llm-agent 返回的模型列表形状不对",
    );
  }
  const items = models
    .filter(
      (m): m is Record<string, unknown> =>
        isRecord(m) && typeof m.id === "string",
    )
    .map((m) => ({
      id: m.id as string,
      displayName:
        typeof m.displayName === "string" ? m.displayName : (m.id as string),
    }));
  return { items, total: items.length };
}

export async function testLlmConnection(
  client: LlmAdminClient | null,
): Promise<LlmTestOutcome> {
  if (!client) throw toDomainError({ kind: "unsupported" });
  const res = await client.request("POST", "/admin/test");
  if (res.kind !== "ok") throw toDomainError(res);
  const b = res.body;
  if (
    !isRecord(b) ||
    typeof b.ok !== "boolean" ||
    typeof b.message !== "string"
  ) {
    throw new BadGateway(
      "LLM_UPSTREAM_ERROR",
      "llm-agent 返回的测试结果形状不对",
    );
  }
  return {
    ok: b.ok,
    latencyMs: typeof b.latencyMs === "number" ? Math.round(b.latencyMs) : 0,
    model: typeof b.model === "string" ? b.model : null,
    message: b.message,
  };
}
