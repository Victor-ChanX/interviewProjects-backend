// Gemini 上游（官方 @google/genai SDK，Gemini Developer API 的 generateContent）。字段名按官方文档核实：
// - SDK README（node_modules/@google/genai/README.md）：functionDeclarations + parametersJsonSchema、
//   toolConfig.functionCallingConfig、ApiError.status。
// - API 参考 https://ai.google.dev/api/generate-content ：Part.functionCall { id, name, args }、
//   Part.functionResponse { id, name, response }（response 里失败用 "error" 键）、Part.thoughtSignature、
//   Candidate.finishReason、promptFeedback.blockReason、responseMimeType + responseJsonSchema（responseSchema 已标 deprecated）。
// - Thought signatures（https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures）：
//   Gemini 3 对 functionCall part 上的 thoughtSignature 做校验，当前轮（从最近一条不是 functionResponse 的 user 消息算起）
//   任一步缺了就 400；要把含签名的 part 原样放回；并行调用只有第一个 functionCall 带签名；确实拿不到签名时
//   （例如历史不是本模型生成的）可以把 thoughtSignature 设为 "skip_thought_signature_validator"，文档说这是最后手段、
//   会降低效果。
// - 思考配置（SDK 官方 codegen_instructions.md）：Gemini 3 用 thinkingConfig.thinkingLevel，2.5 用 thinkingBudget。
//
// /agent/turn：2.2 的 tools → functionDeclarations（input_schema 原样作 parametersJsonSchema）；messages → contents：
// user text → user 的 text part；assistant tool_use → model 的 functionCall part；user tool_result → user 的
// functionResponse part（name 按 tool_use_id 从历史里找，is_error 时放在 "error" 键下，否则 "output"）。
// 会话状态：app.ts 按 runId + tool_use.id 记住上游返回的完整 model Content（含 thoughtSignature），这里换回去；
// 记不到（该轮被后端判了协议错误、换了模型、记忆被上限挤掉）时按上面文档用 skip_thought_signature_validator 构造那一步，
// 请求不会 400，只是模型少了那一步的推理状态。
// Gemini 3 的思考等级设 LOW（群聊短回复 + 每轮 10s 预算）；其他模型用默认。
//
// 响应 → 2.2 的「恰好一个块」：有 functionCall 取第一个（id 用上游给的，没有或与历史重复就生成，记住的 Content 里的
// functionCall 保持原样，下一轮 functionResponse 的 id 跟着它走）；安全类拦截（promptFeedback.blockReason、
// finishReason 为 SAFETY 等）→ end_turn 写明模型拒绝；MALFORMED_FUNCTION_CALL → 502；否则拼非思考的 text → end_turn。
import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";

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
  type AgentMessage,
  type AgentTool,
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
const GEMINI_API = "https://generativelanguage.googleapis.com/";

/** 文档给的「拿不到签名时」的占位值（最后手段） */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** 候选结果被安全 / 合规类原因拦下：按「模型拒绝」结束，不是协议错误 */
const BLOCKED_FINISH: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.LANGUAGE,
]);

export type GeminiClientOptions = {
  /** 测试替身（tests/fake-gemini.ts）的地址；生产不传，固定官方端点。不暴露给控制台 */
  testBaseUrl?: string;
  /** SDK 对 408 / 429 / 5xx 的重试次数（仍受每次调用的总预算约束） */
  maxRetries: number;
  /** 首次重试前的等待毫秒数，默认 500；测试传小值 */
  retryInitialDelayMs?: number;
};

/** Gemini 3 系列用 thinkingLevel（LOW）；其他模型不设，用默认 */
export function thinkingConfigFor(
  model: string,
): GenerateContentConfig["thinkingConfig"] {
  return /^gemini-3/.test(model)
    ? { thinkingLevel: ThinkingLevel.LOW }
    : undefined;
}

/** 记住的内容要像一个 model Content 才用（文件被改坏时按「记不到」处理） */
function asStoredContent(value: unknown): Content | null {
  if (!isRecord(value) || value.role !== "model") return null;
  const parts = value.parts;
  if (
    !Array.isArray(parts) ||
    !parts.some((p) => isRecord(p) && p.functionCall)
  )
    return null;
  return value;
}

const firstFunctionCallId = (content: Content): string | undefined =>
  content.parts?.find((p) => p.functionCall)?.functionCall?.id;

function parseResult(content: unknown): unknown {
  const text = toolResultText(content);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 2.2 的 messages → contents。assistant tool_use 回合换回记住的 model Content（含 thoughtSignature）；
 * 记不到时构造 functionCall part，签名用文档的占位值。相邻的 user 内容合并成一条（functionResponse 在前）。
 */
export function toGeminiContents(
  messages: readonly AgentMessage[],
  recall: (toolUseId: string) => unknown,
): { contents: Content[]; replayed: number; missing: number } {
  const contents: Content[] = [];
  /** tool_use.id → { 函数名, 发给上游的 functionCall.id } */
  const calls = new Map<string, { name: string; callId: string | undefined }>();
  let replayed = 0;
  let missing = 0;

  const pushUser = (parts: Part[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last?.role === "user") {
      last.parts = [...(last.parts ?? []), ...parts];
      return;
    }
    contents.push({ role: "user", parts });
  };

  for (const m of messages) {
    if (m.role === "assistant") {
      const toolUse = m.content.find((b) => b.type === "tool_use");
      if (toolUse?.type === "tool_use") {
        const stored = asStoredContent(recall(toolUse.id));
        if (stored) {
          replayed += 1;
          contents.push(stored);
          calls.set(toolUse.id, {
            name: toolUse.name,
            callId: firstFunctionCallId(stored),
          });
          continue;
        }
        missing += 1;
        calls.set(toolUse.id, { name: toolUse.name, callId: toolUse.id });
        contents.push({
          role: "model",
          parts: [
            {
              functionCall: {
                id: toolUse.id,
                name: toolUse.name,
                args: toolUse.input,
              },
              thoughtSignature: SKIP_THOUGHT_SIGNATURE,
            },
          ],
        });
        continue;
      }
      const texts = m.content.flatMap((b) =>
        b.type === "text" ? [{ text: b.text }] : [],
      );
      if (texts.length > 0) contents.push({ role: "model", parts: texts });
      continue;
    }

    const parts: Part[] = [];
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const call = calls.get(b.tool_use_id);
      if (!call) {
        parts.push({
          text: `工具调用 ${b.tool_use_id} 的结果：${toolResultText(b.content)}`,
        });
        continue;
      }
      const value = parseResult(b.content);
      parts.push({
        functionResponse: {
          ...(call.callId ? { id: call.callId } : {}),
          name: call.name,
          response: b.is_error === true ? { error: value } : { output: value },
        },
      });
    }
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
    }
    pushUser(parts);
  }
  return { contents, replayed, missing };
}

/** /agent/turn 的 generateContent 配置（导出给测试断言形状） */
export function turnConfig(
  model: string,
  tools: readonly AgentTool[],
): GenerateContentConfig {
  const thinkingConfig = thinkingConfigFor(model);
  return {
    systemInstruction: TURN_SYSTEM_PROMPT,
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.input_schema,
        })),
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
    },
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

const refusalText = (reason: string): string =>
  `模型拒绝了这次请求（${reason}），本次处理结束。`;

export function fromGeminiResponse(
  response: GenerateContentResponse,
  model: string,
  usedIds: ReadonlySet<string>,
): TurnResult {
  const servedBy = response.modelVersion ?? model;
  const candidate = response.candidates?.[0];
  if (!candidate) {
    const blocked = response.promptFeedback?.blockReason;
    if (blocked) {
      return {
        response: endTurnResponse(refusalText(blocked)),
        replay: null,
        servedBy,
      };
    }
    throw new UpstreamError(null, "上游响应里没有候选结果（candidates 为空）");
  }
  const parts = candidate.content?.parts ?? [];
  const index = parts.findIndex((p) => p.functionCall);
  const call = parts[index]?.functionCall;
  if (call) {
    if (!call.name) {
      throw new UpstreamError(null, "上游返回的 functionCall 缺少 name");
    }
    const id = pickToolUseId(call.id, usedIds);
    // 只记到第一个 functionCall 为止：后端只会回一个 tool_result；签名在第一个 functionCall 上
    const replay: Content = { role: "model", parts: parts.slice(0, index + 1) };
    return {
      response: toolUseResponse({
        id,
        name: call.name,
        input: isRecord(call.args) ? call.args : {},
      }),
      replay,
      servedBy,
    };
  }
  const reason = candidate.finishReason;
  if (reason && BLOCKED_FINISH.has(reason)) {
    return {
      response: endTurnResponse(refusalText(reason)),
      replay: null,
      servedBy,
    };
  }
  if (reason === FinishReason.MALFORMED_FUNCTION_CALL) {
    throw new UpstreamError(
      null,
      "模型生成的函数调用不合法（MALFORMED_FUNCTION_CALL）",
    );
  }
  const text = parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("");
  return { response: endTurnResponse(text), replay: null, servedBy };
}

/**
 * Google API 错误体（{ error: { details: [{ "@type": ….ErrorInfo, reason }] } }，SDK 的 ApiError.message 就是它的 JSON 原文）
 * 里的 ErrorInfo.reason。Gemini 对无效 key 回 400 INVALID_ARGUMENT + reason API_KEY_INVALID，不是 401。
 */
function errorInfoReason(message: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    return null;
  }
  const details =
    isRecord(body) && isRecord(body.error) && Array.isArray(body.error.details)
      ? body.error.details
      : [];
  for (const d of details) {
    if (
      isRecord(d) &&
      typeof d["@type"] === "string" &&
      d["@type"].endsWith("google.rpc.ErrorInfo") &&
      typeof d.reason === "string"
    ) {
      return d.reason;
    }
  }
  return null;
}

function toUpstreamError(
  err: unknown,
  signal: AbortSignal,
  apiKey: string,
  timeoutMs: number,
): UpstreamError {
  if (signal.aborted) return new UpstreamError(null, timeoutMessage(timeoutMs));
  if (err instanceof ApiError) {
    return new UpstreamError(
      err.status,
      redact(shorten(`上游返回 HTTP ${err.status}：${err.message}`), apiKey),
      {
        keyRejected:
          err.status === 401 ||
          err.status === 403 ||
          errorInfoReason(err.message) === "API_KEY_INVALID",
      },
    );
  }
  if (err instanceof UpstreamError) return err;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const detail =
    cause instanceof Error
      ? cause.message
      : err instanceof Error
        ? err.message
        : String(err);
  return new UpstreamError(
    null,
    redact(shorten(`上游连接失败：${detail}`), apiKey),
  );
}

export function createGeminiClient(opts: GeminiClientOptions): LlmClient {
  // key 每次来自配置文件，所以每次调用建一个客户端。vertexai 与端点显式给出：不让 SDK 按环境变量切到
  // Vertex AI 或别的端点（把 key 带到别处）。重试交给 SDK（默认不重试，这里显式开）。
  const clientFor = (apiKey: string): GoogleGenAI =>
    new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: {
        baseUrl: opts.testBaseUrl ?? GEMINI_API,
        ...(opts.maxRetries > 0
          ? {
              retryOptions: {
                attempts: opts.maxRetries + 1,
                initialDelay: (opts.retryInitialDelayMs ?? 500) / 1000,
                maxDelay: 1,
              },
            }
          : {}),
      },
    });

  return {
    provider: "gemini",

    async turn(input, { timeoutMs }) {
      const { contents } = toGeminiContents(input.messages, input.recall);
      // 总预算：abortSignal 到点中止当前尝试与之后的重试
      const signal = AbortSignal.timeout(timeoutMs);
      let response: GenerateContentResponse;
      try {
        response = await clientFor(input.apiKey).models.generateContent({
          model: input.model,
          contents,
          config: {
            ...turnConfig(input.model, input.tools),
            abortSignal: signal,
          },
        });
      } catch (err) {
        throw toUpstreamError(err, signal, input.apiKey, timeoutMs);
      }
      return fromGeminiResponse(
        response,
        input.model,
        historyToolUseIds(input.messages),
      );
    },

    async audit(input, { timeoutMs }): Promise<AuditVerdict> {
      const signal = AbortSignal.timeout(timeoutMs);
      const thinkingConfig = thinkingConfigFor(input.model);
      let response: GenerateContentResponse;
      try {
        response = await clientFor(input.apiKey).models.generateContent({
          model: input.model,
          contents: [
            {
              role: "user",
              parts: [{ text: auditUserMessage(input.text, input.groupId) }],
            },
          ],
          config: {
            systemInstruction: AUDIT_SYSTEM_PROMPT,
            responseMimeType: "application/json",
            responseJsonSchema: { ...VERDICT_JSON_SCHEMA },
            ...(thinkingConfig ? { thinkingConfig } : {}),
            abortSignal: signal,
          },
        });
      } catch (err) {
        throw toUpstreamError(err, signal, input.apiKey, timeoutMs);
      }
      const candidate = response.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .filter((p) => typeof p.text === "string" && p.thought !== true)
        .map((p) => p.text)
        .join("");
      const verdict = parseVerdict(text);
      if (!verdict) {
        const why =
          response.promptFeedback?.blockReason ?? candidate?.finishReason;
        throw new UpstreamError(
          null,
          why && why !== FinishReason.STOP
            ? `审计模型没有给出结论（${why}）`
            : "模型输出不是 { verdict: pass | fail, reason } 形状的 JSON",
        );
      }
      return verdict;
    },

    /** models.list（自动翻页），只留支持 generateContent 的模型（Model.supportedActions，即 REST 的 supportedGenerationMethods） */
    async listModels(apiKey, { timeoutMs }): Promise<ModelItem[]> {
      const signal = AbortSignal.timeout(timeoutMs);
      const items: ModelItem[] = [];
      try {
        const pager = await clientFor(apiKey).models.list({
          config: { pageSize: 100, abortSignal: signal },
        });
        for await (const m of pager) {
          if (!m.name || !m.supportedActions?.includes("generateContent")) {
            continue;
          }
          const id = m.name.replace(/^models\//, "");
          items.push({ id, displayName: m.displayName ?? id });
        }
      } catch (err) {
        throw toUpstreamError(err, signal, apiKey, timeoutMs);
      }
      return items;
    },
  };
}
