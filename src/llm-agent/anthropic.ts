// （typescript/claude-api/README.md、tool-use.md、shared/tool-use-concepts.md、shared/model-migration.md、shared/models.md）。
//
// /agent/turn：题目 2.2 的请求本身就是 Anthropic tool use 形状 —— tools（input_schema 原样）与 messages 直通，
// 加中文系统提示词。几条按文档定下的参数：
// - tool_choice 只用 { type: "auto", disable_parallel_tool_use: true }：当前模型（Claude Opus 5.5 等）拒绝强制工具调用
//   （any / tool 返回 400）；disable_parallel_tool_use 让一次最多一个 tool_use，正好对上 2.2「每轮恰好一个块」。
// - thinking: { type: "adaptive" } + output_config.effort = "low"：当前模型思考关不掉（disabled 返回 400），
//   effort 是唯一的控制；群聊助手回复短、每轮只有 LLM_TIMEOUT_MS（默认 10s）预算，文档建议对话 / 简单任务用 low。
// - max_tokens 16000：文档对非流式请求的默认建议；思考也计入 max_tokens，给小了会截断。延迟由总预算约束，不靠它。
// - 顶层 cache_control 自动缓存：同一个 run 的历史只追加，前缀（tools → system → 之前的轮次）每轮都能命中。
// - 拒绝兜底（refusal fallbacks）：文档要求对 claude-fable-5-1 / claude-opus-5-5 / claude-opus-5 / claude-sonnet-5-5
//   默认开启服务端 fallbacks: "default"（beta server-side-fallback-2026-07-01，按拒绝类别选 Anthropic 推荐的备用模型，
//   不用自己维护模型名）；其他模型不带这个参数。备用模型读不了原模型的思考块，API 会静默丢弃（不计费），不影响请求。
//
// 思考块回传（多轮工具调用必须原样带回 assistant 回合里的 thinking 块）：app.ts 按 runId + tool_use.id 记住每次上游
// 返回的完整 content（session-store.ts），这里把后端传回来的 assistant tool_use 回合换回那份完整 content。
// 记不到时（该轮被后端判了协议错误没进历史、记忆被上限挤掉、换了模型）按文档（model-migration.md → Migrating to
// Claude Fable 5.1 from Claude Fable 5 → Breaking change 3）处理：思考块「从最前面删一段」是允许的；中途删掉一个会让
// 之后的思考块全部失效（新账号直接 400）。所以：前面连续记不到的轮次不带思考、后面记得到的照常回传；一旦在已经回传过
// 之后遇到记不到的轮次，从这一轮起之后都不再回传思考块（只发 tool_use）—— 文档给的恢复方式正是「去掉那个块及之后的
// 全部思考块，text 与 tool_use 保留」，这样请求不会 400，只是模型少了那几轮的推理上下文。
//
// 响应 → 2.2 的「恰好一个块」：refusal → end_turn（text 写明模型拒绝）；有 tool_use 取第一个（max_tokens 截断的
// 工具调用入参可能不完整 → 502）；否则拼 text → end_turn。
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  MessageCreateParamsNonStreaming,
  BetaMessageParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { redact } from "./config-store.js";
import { AUDIT_SYSTEM_PROMPT, TURN_SYSTEM_PROMPT } from "./prompts.js";
import {
  VERDICT_JSON_SCHEMA,
  auditUserMessage,
  endTurnResponse,
  historyToolUseIds,
  isRecord,
  parseVerdict,
  pickToolUseId,
  toolResultText,
  toolUseResponse,
  type AgentBlock,
  type AgentMessage,
  type AuditVerdict,
} from "./protocol.js";
import {
  UpstreamError,
  shorten,
  timeoutMessage,
  type LlmClient,
  type ModelItem,
  type TurnResult,
} from "./upstream.js";

/** 官方端点，显式传给 SDK：SDK 没收到时会去读环境变量，这里不给环境变量改端点（把 key 带到别处）的机会 */
const ANTHROPIC_API = "https://api.anthropic.com";

/** 非流式请求的 max_tokens */
export const TURN_MAX_TOKENS = 16_000;
/** 审计输出只有一个小 JSON，但思考同样计入 max_tokens，留足余量 */
export const AUDIT_MAX_TOKENS = 4_096;

/** 文档要求默认开启拒绝兜底的模型 */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AnthropicClientOptions = {
  /** 测试替身（tests/fake-anthropic.ts）的地址；生产不传，固定官方端点。不暴露给控制台 */
  testBaseURL?: string;
  /** SDK 对 408 / 409 / 429 / 5xx / 连接失败的重试次数（仍受每次调用的总预算约束） */
  maxRetries: number;
};

const fallbackParams = (
  model: string,
): Partial<Pick<MessageCreateParamsNonStreaming, "fallbacks" | "betas">> =>
  FALLBACK_MODELS.has(model)
    ? { fallbacks: "default", betas: [FALLBACK_BETA] }
    : {};

function toParam(block: AgentBlock): BetaContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: toolResultText(block.content),
        ...(block.is_error === true ? { is_error: true } : {}),
      };
  }
}

/** 记住的内容要像一个 content 块数组才用（文件被改坏时按「记不到」处理） */
function asStoredContent(value: unknown): BetaContentBlockParam[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((b) => isRecord(b) && typeof b.type === "string")) {
    return null;
  }
  return value as BetaContentBlockParam[];
}

/**
 * 2.2 的 messages → Messages API 的 messages，assistant tool_use 回合换回记住的完整 content（含 thinking 块）。
 * 规则见文件头：前面连续记不到的允许；回传开始后再遇到记不到的，从那里起不再回传。
 */
export function toAnthropicMessages(
  messages: readonly AgentMessage[],
  recall: (toolUseId: string) => unknown,
): { messages: BetaMessageParam[]; replayed: number; missing: number } {
  let replayed = 0;
  let missing = 0;
  let stopped = false;
  const out = messages.map((m): BetaMessageParam => {
    if (m.role === "assistant") {
      const toolUse = m.content.find((b) => b.type === "tool_use");
      if (toolUse) {
        const stored = stopped ? null : asStoredContent(recall(toolUse.id));
        if (stored) {
          replayed += 1;
          return { role: "assistant", content: stored };
        }
        missing += 1;
        if (replayed > 0) stopped = true;
      }
    }
    return { role: m.role, content: m.content.map(toParam) };
  });
  return { messages: out, replayed, missing };
}

/** /agent/turn 的上游请求体（导出给测试断言形状） */
export function turnParams(input: {
  model: string;
  tools: readonly { name: string; description: string; input_schema: object }[];
  messages: BetaMessageParam[];
}): MessageCreateParamsNonStreaming {
  return {
    model: input.model,
    max_tokens: TURN_MAX_TOKENS,
    system: TURN_SYSTEM_PROMPT,
    tools: input.tools.map((t): BetaTool => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as BetaTool.InputSchema,
    })),
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    cache_control: { type: "ephemeral" },
    messages: input.messages,
    ...fallbackParams(input.model),
  };
}

/** refusal 时 end_turn 的文字（后端把它存为 run 的 summary，不发到群里） */
function refusalText(message: BetaMessage): string {
  const category = message.stop_details?.category;
  return `模型拒绝了这次请求${category ? `（类别：${category}）` : ""}，本次处理结束。`;
}

/** 服务端 fallback 在 content 里留下 fallback 标记块；它之前的内容不回传（文档：echoing fallback turns back） */
function afterLastFallback(content: BetaContentBlock[]): BetaContentBlock[] {
  let last = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") last = i;
  });
  return content.slice(last + 1);
}

export function fromAnthropicMessage(
  message: BetaMessage,
  usedIds: ReadonlySet<string>,
): TurnResult {
  const servedBy = message.model;
  if (message.stop_reason === "refusal") {
    return {
      response: endTurnResponse(refusalText(message)),
      replay: null,
      servedBy,
    };
  }
  const blocks = afterLastFallback(message.content);
  const index = blocks.findIndex((b) => b.type === "tool_use");
  const toolUse = blocks[index];
  if (toolUse?.type === "tool_use") {
    if (message.stop_reason === "max_tokens") {
      throw new UpstreamError(
        null,
        "模型输出在工具调用处被 max_tokens 截断，入参可能不完整",
      );
    }
    const id = pickToolUseId(toolUse.id, usedIds);
    const input = isRecord(toolUse.input) ? toolUse.input : {};
    // 只记到第一个 tool_use 为止：后端只会回一个 tool_result，多出来的 tool_use 回传会让上游 400
    const replay = [
      ...blocks.slice(0, index),
      { ...toolUse, id },
    ] as BetaContentBlockParam[];
    return {
      response: toolUseResponse({ id, name: toolUse.name, input }),
      replay,
      servedBy,
    };
  }
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { response: endTurnResponse(text), replay: null, servedBy };
}

/** SDK 的类型化异常 → UpstreamError（按文档从具体到宽泛；APIConnectionError 是 APIError 的子类，先判） */
function toUpstreamError(
  err: unknown,
  apiKey: string,
  timeoutMs: number,
): UpstreamError {
  if (
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new UpstreamError(null, timeoutMessage(timeoutMs));
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new UpstreamError(
      null,
      redact(`上游连接失败：${err.message}`, apiKey),
    );
  }
  if (err instanceof Anthropic.APIError) {
    const raw: unknown = err.status;
    const status = typeof raw === "number" ? raw : null;
    return new UpstreamError(
      status,
      redact(shorten(`上游返回 HTTP ${status ?? "?"}：${err.message}`), apiKey),
    );
  }
  if (err instanceof UpstreamError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new UpstreamError(null, redact(shorten(message), apiKey));
}

export function createAnthropicClient(opts: AnthropicClientOptions): LlmClient {
  // key 每次来自配置文件（控制台改了不用重启），所以每次调用建一个客户端（只是个配置对象，不建连接池）。
  // 端点与 authToken 显式给出：不让 SDK 从环境变量取端点或另一份凭据。
  const clientFor = (apiKey: string): Anthropic =>
    new Anthropic({
      apiKey,
      authToken: null,
      baseURL: opts.testBaseURL ?? ANTHROPIC_API,
      maxRetries: opts.maxRetries,
    });
  // 总预算：signal 到点就中止（包括 SDK 重试之间的等待），timeout 约束单次尝试
  const requestOptions = (timeoutMs: number) => ({
    signal: AbortSignal.timeout(timeoutMs),
    timeout: timeoutMs,
  });

  return {
    provider: "anthropic",

    async turn(input, { timeoutMs }) {
      const { messages } = toAnthropicMessages(input.messages, input.recall);
      let message: BetaMessage;
      try {
        message = await clientFor(input.apiKey).beta.messages.create(
          turnParams({ model: input.model, tools: input.tools, messages }),
          requestOptions(timeoutMs),
        );
      } catch (err) {
        throw toUpstreamError(err, input.apiKey, timeoutMs);
      }
      return fromAnthropicMessage(message, historyToolUseIds(input.messages));
    },

    async audit(input, { timeoutMs }): Promise<AuditVerdict> {
      let message: BetaMessage;
      try {
        message = await clientFor(input.apiKey).beta.messages.create(
          {
            model: input.model,
            max_tokens: AUDIT_MAX_TOKENS,
            system: AUDIT_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: auditUserMessage(input.text, input.groupId),
              },
            ],
            thinking: { type: "adaptive" },
            output_config: {
              effort: "low",
              format: {
                type: "json_schema",
                schema: { ...VERDICT_JSON_SCHEMA },
              },
            },
            ...fallbackParams(input.model),
          },
          requestOptions(timeoutMs),
        );
      } catch (err) {
        throw toUpstreamError(err, input.apiKey, timeoutMs);
      }
      if (message.stop_reason === "refusal") {
        throw new UpstreamError(null, "审计模型拒绝了这次请求，没有给出结论");
      }
      const text = afterLastFallback(message.content)
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const verdict = parseVerdict(text);
      if (!verdict) {
        throw new UpstreamError(
          null,
          message.stop_reason === "max_tokens"
            ? "审计输出被 max_tokens 截断"
            : "模型输出不是 { verdict: pass | fail, reason } 形状的 JSON",
        );
      }
      return verdict;
    },

    /**
     * Models API（自动翻页），只留本服务用得上的模型：adaptive 思考、low effort、结构化输出都支持
     * 。顺序按 API 返回（新的在前）。
     */
    async listModels(apiKey, { timeoutMs }): Promise<ModelItem[]> {
      const items: ModelItem[] = [];
      try {
        for await (const m of clientFor(apiKey).models.list(
          { limit: 100 },
          requestOptions(timeoutMs),
        )) {
          const caps = m.capabilities;
          if (
            caps?.thinking.types.adaptive.supported &&
            caps.effort.low.supported &&
            caps.structured_outputs.supported
          ) {
            items.push({ id: m.id, displayName: m.display_name });
          }
        }
      } catch (err) {
        throw toUpstreamError(err, apiKey, timeoutMs);
      }
      return items;
    },
  };
}
