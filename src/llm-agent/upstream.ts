// 两家上游（anthropic.ts / gemini.ts）对 app.ts 暴露的同一个接口。app.ts 只按配置里的 provider 挑一个，
// 不关心各家的请求形状；失败一律 throw UpstreamError，由 app.ts 按端点映射成 502 / 500 / 422。
import type { Provider } from "./config-store.js";
import type {
  AgentMessage,
  AgentTool,
  AuditVerdict,
  TurnResponse,
} from "./protocol.js";

/**
 * 上游调用失败：status 是上游的 HTTP 状态（超时 / 连不上为 null），message 已去掉 key。
 * keyRejected：上游明确拒绝了这个 key —— 401 / 403，或 Gemini 对无效 key 回的 400 + ErrorInfo.reason = API_KEY_INVALID。
 */
export class UpstreamError extends Error {
  readonly keyRejected: boolean;
  constructor(
    readonly status: number | null,
    message: string,
    opts: { keyRejected?: boolean } = {},
  ) {
    super(message);
    this.name = "UpstreamError";
    this.keyRejected = opts.keyRejected ?? (status === 401 || status === 403);
  }
}

export type ModelItem = { id: string; displayName: string };

export type TurnInput = {
  apiKey: string;
  model: string;
  tools: readonly AgentTool[];
  messages: readonly AgentMessage[];
  /**
   * 按 tool_use.id 取回之前记住的完整 assistant 回合（session-store.ts，已按 provider + model 过滤）；
   * 记不到返回 undefined。
   */
  recall: (toolUseId: string) => unknown;
};

export type TurnResult = {
  response: TurnResponse;
  /** 要按 response 的 tool_use.id 记住的完整回合；end_turn 为 null */
  replay: unknown;
  /** 实际作答的模型（Claude 的服务端 fallback 可能换了模型） */
  servedBy: string;
};

export type CallOptions = {
  /** 本次调用的总预算（含 SDK 的重试与退避） */
  timeoutMs: number;
};

export type LlmClient = {
  readonly provider: Provider;
  turn(input: TurnInput, opts: CallOptions): Promise<TurnResult>;
  /** 拿不到明确结论（含上游失败）一律 throw UpstreamError */
  audit(
    input: { apiKey: string; model: string; text: string; groupId: string },
    opts: CallOptions,
  ): Promise<AuditVerdict>;
  listModels(apiKey: string, opts: CallOptions): Promise<ModelItem[]>;
};

export const timeoutMessage = (timeoutMs: number): string =>
  `上游在 ${timeoutMs}ms 内没有返回`;

/** 上游错误信息截短（有的错误体是整页 HTML） */
export const shorten = (text: string): string =>
  text.length > 300 ? `${text.slice(0, 300)}…` : text;
