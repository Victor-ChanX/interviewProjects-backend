// Agent 服务（题目 2.2）的 HTTP 客户端：/agent/turn 与 /agent/audit（issue #12）。
//
// 只做「一次往返 + 按题目规则判定响应合不合法」，不做循环、不碰库：
// - turn：返回原始响应体（rawResponse 落库要它）+ 解析结果。非 2xx / 不是合法 JSON（外面套 markdown 代码围栏、
//   前后夹着文字都算）/ 缺 stop_reason / 块数 ≠ 1 / stop_reason 与块类型不符 → BAD_JSON；超时 → TURN_TIMEOUT。
//   超时用 AbortController：一旦超时 fetch 被 abort，**之后才到的响应永远读不到**（题目：超时后才到的响应丢弃）。
//   连不上（ECONNREFUSED 等）也归 BAD_JSON：对 run 来说都是「这轮没拿到合法响应」，计一次协议错误。
// - audit：只有「合法 JSON 且 verdict 恰为 pass / fail」才是结论；500、非 JSON、没有 verdict、verdict 是别的值、
//   超时都是 unknown（拿不到结论），由 service 决定重试与 blocked。
// - 用全局 fetch（undici）：tests/setup.ts 的 MockAgent 只接管 fetch。base url 默认 config.agentUrl（AGENT_URL），
//   测试把模拟器（src/sim/agent，listen(0)）的地址传进 createAgentClient。
// 与 gateway-client 分开：两个外部服务、两套错误语义（网关的 4xx 是业务拒绝，Agent 的非 2xx 是协议错误）。
import { config } from "../core/config.js";

// ---- 协议形状（Anthropic Messages API 的 tool use 子集）--------------------------------------

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type AgentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export type AgentMessage = {
  role: "user" | "assistant";
  content: AgentBlock[];
};

/** 合法的一轮响应：恰好一个块，且 stop_reason 与块类型一致 */
export type ParsedTurn =
  | { stop_reason: "tool_use"; block: ToolUseBlock }
  | { stop_reason: "end_turn"; text: string };

/** 题目 A5 第 3 条里「不追加 assistant 块」的三类协议错误中，客户端能判定的两类（DUPLICATE_TOOL_USE_ID 由 service 按库判） */
export type TurnProtocolErrorCode = "BAD_JSON" | "TURN_TIMEOUT";

export type TurnResult =
  | { ok: true; status: number; raw: string; turn: ParsedTurn }
  | {
      ok: false;
      status: number | null;
      /** 原始响应体（非 JSON 时也原样给；超时 / 连不上时是一句说明） */
      raw: string;
      code: TurnProtocolErrorCode;
      /** 一句话，进 PROTOCOL_ERROR <code>: <reason> */
      reason: string;
    };

export type TurnInput = {
  runId: string;
  tools: readonly AgentTool[];
  messages: readonly AgentMessage[];
};

export type TurnOptions = {
  timeoutMs: number;
  /** 停机时 abort（与超时合并） */
  signal?: AbortSignal;
};

export type AuditVerdictOutcome = "pass" | "fail" | "unknown";

export type AuditResult = {
  verdict: AuditVerdictOutcome;
  /** Agent 给的 reason（有则给）；unknown 时是「为什么没拿到结论」 */
  reason: string | null;
  status: number | null;
  raw: string;
};

export type AgentClient = {
  turn(input: TurnInput, opts: TurnOptions): Promise<TurnResult>;
  audit(
    input: { text: string; groupId: string },
    opts: { timeoutMs: number },
  ): Promise<AuditResult>;
};

// ---- 响应校验（纯函数，导出给测试 / service 用）-----------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 原始响应体 → ParsedTurn 或一句话说明为什么不合法。
 * JSON.parse 本身就拒绝代码围栏与前后夹文字（它们不是合法 JSON 文本）；这里再核对形状。
 */
export function parseTurnBody(
  raw: string,
): { ok: true; turn: ParsedTurn } | { ok: false; reason: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "响应体不是合法 JSON" };
  }
  if (!isRecord(body)) return { ok: false, reason: "响应体不是 JSON 对象" };
  const stopReason = body.stop_reason;
  if (stopReason === undefined)
    return { ok: false, reason: "缺少 stop_reason" };
  if (stopReason !== "tool_use" && stopReason !== "end_turn") {
    return {
      ok: false,
      reason: `stop_reason 不合法：${JSON.stringify(stopReason)}`,
    };
  }
  const content = body.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return {
      ok: false,
      reason: `content 必须恰好一个块，收到 ${Array.isArray(content) ? content.length : "非数组"}`,
    };
  }
  const block: unknown = content[0];
  if (!isRecord(block) || typeof block.type !== "string") {
    return { ok: false, reason: "content[0] 不是带 type 的块" };
  }
  if (stopReason === "tool_use") {
    if (block.type !== "tool_use") {
      return {
        ok: false,
        reason: `stop_reason=tool_use 但块类型是 ${block.type}`,
      };
    }
    if (typeof block.id !== "string" || block.id === "") {
      return { ok: false, reason: "tool_use 块缺少 id" };
    }
    if (typeof block.name !== "string" || block.name === "") {
      return { ok: false, reason: "tool_use 块缺少 name" };
    }
    const input = block.input === undefined ? {} : block.input;
    if (!isRecord(input))
      return { ok: false, reason: "tool_use 块的 input 不是对象" };
    return {
      ok: true,
      turn: {
        stop_reason: "tool_use",
        block: { type: "tool_use", id: block.id, name: block.name, input },
      },
    };
  }
  if (block.type !== "text") {
    return {
      ok: false,
      reason: `stop_reason=end_turn 但块类型是 ${block.type}`,
    };
  }
  if (typeof block.text !== "string") {
    return { ok: false, reason: "text 块缺少 text" };
  }
  return { ok: true, turn: { stop_reason: "end_turn", text: block.text } };
}

/** 审计响应体 → 结论；只有合法 JSON 且 verdict 恰为 pass / fail 才算拿到结论 */
export function parseAuditBody(raw: string): {
  verdict: AuditVerdictOutcome;
  reason: string | null;
} {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { verdict: "unknown", reason: "审计响应不是合法 JSON" };
  }
  if (!isRecord(body))
    return { verdict: "unknown", reason: "审计响应不是 JSON 对象" };
  const verdict = body.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    return {
      verdict: "unknown",
      reason:
        verdict === undefined
          ? "审计响应缺少 verdict"
          : `审计 verdict 不是 pass / fail：${JSON.stringify(verdict)}`,
    };
  }
  return {
    verdict,
    reason: typeof body.reason === "string" ? body.reason : null,
  };
}

// ---- 客户端 ------------------------------------------------------------------------------

export type CreateAgentClientOptions = {
  baseUrl: string;
  /** 默认全局 fetch；测试可注入 */
  fetch?: typeof fetch;
};

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function createAgentClient(opts: CreateAgentClientOptions): AgentClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;

  /**
   * 一次 POST：返回 { status, raw }；超时 / 被 abort → { timedOut: true }；连不上 → { unreachable }。
   * 超时靠 AbortController：到点 abort，之后到达的字节不会再被读到（响应在传输层被丢弃）。
   */
  async function post(
    path: string,
    payload: unknown,
    timeoutMs: number,
    external?: AbortSignal,
  ): Promise<
    | { kind: "response"; status: number; raw: string }
    | { kind: "timeout" }
    | { kind: "unreachable"; reason: string }
  > {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(timeoutMs);
    const onAbort = (): void => controller.abort();
    timeout.addEventListener("abort", onAbort, { once: true });
    external?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw = await res.text();
      return { kind: "response", status: res.status, raw };
    } catch (err) {
      if (controller.signal.aborted || isAbortLike(err)) {
        return { kind: "timeout" };
      }
      const cause = (err as { cause?: unknown } | null)?.cause;
      const detail =
        cause instanceof Error
          ? cause.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { kind: "unreachable", reason: detail };
    } finally {
      timeout.removeEventListener("abort", onAbort);
      external?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async turn(input, opts) {
      const r = await post(
        "/agent/turn",
        { runId: input.runId, tools: input.tools, messages: input.messages },
        opts.timeoutMs,
        opts.signal,
      );
      if (r.kind === "timeout") {
        return {
          ok: false,
          status: null,
          raw: `（/agent/turn 在 ${opts.timeoutMs}ms 内没有返回，响应已丢弃）`,
          code: "TURN_TIMEOUT",
          reason: `/agent/turn 超过 ${opts.timeoutMs}ms 未返回`,
        };
      }
      if (r.kind === "unreachable") {
        return {
          ok: false,
          status: null,
          raw: `（/agent/turn 请求失败：${r.reason}）`,
          code: "BAD_JSON",
          reason: `Agent 服务不可达：${r.reason}`,
        };
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          ok: false,
          status: r.status,
          raw: r.raw,
          code: "BAD_JSON",
          reason: `/agent/turn 返回 HTTP ${r.status}`,
        };
      }
      const parsed = parseTurnBody(r.raw);
      if (!parsed.ok) {
        return {
          ok: false,
          status: r.status,
          raw: r.raw,
          code: "BAD_JSON",
          reason: parsed.reason,
        };
      }
      return { ok: true, status: r.status, raw: r.raw, turn: parsed.turn };
    },

    async audit(input, opts) {
      const r = await post("/agent/audit", input, opts.timeoutMs);
      if (r.kind === "timeout") {
        return {
          verdict: "unknown",
          reason: `/agent/audit 超过 ${opts.timeoutMs}ms 未返回`,
          status: null,
          raw: "",
        };
      }
      if (r.kind === "unreachable") {
        return {
          verdict: "unknown",
          reason: `Agent 服务不可达：${r.reason}`,
          status: null,
          raw: "",
        };
      }
      if (r.status < 200 || r.status >= 300) {
        return {
          verdict: "unknown",
          reason: `/agent/audit 返回 HTTP ${r.status}`,
          status: r.status,
          raw: r.raw,
        };
      }
      const parsed = parseAuditBody(r.raw);
      return { ...parsed, status: r.status, raw: r.raw };
    },
  };
}

/**
 * 生产用：base url 来自 AGENT_URL。惰性：缺了在第一次调 Agent 服务时报错，而不是进程启动时 ——
 * 生成地图 / 导 openapi 与不碰 Agent 的测试都会走到 src/main.ts 之外的构建路径，那时没有 AGENT_URL。
 */
export function agentClientFromConfig(): AgentClient {
  let real: AgentClient | undefined;
  const resolve = (): AgentClient => {
    if (!real) {
      if (!config.agentUrl) {
        throw new Error("缺少 AGENT_URL：调 Agent 服务需要它");
      }
      real = createAgentClient({ baseUrl: config.agentUrl });
    }
    return real;
  };
  return {
    turn: (input, opts) => resolve().turn(input, opts),
    audit: (input, opts) => resolve().audit(input, opts),
  };
}
