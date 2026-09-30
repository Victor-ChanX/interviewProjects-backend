// 服务商差异（按 base url 的主机名 + 模型名匹配）：只放官方文档写明、且不加就跑不通的请求体参数。
//
// 为什么需要：本服务不存会话，拿不到上一轮的 reasoning_content；而有的服务商在「思考模式 + 带 tools」时要求把
// 之前每一轮的 reasoning_content 原样回传，否则 400（DeepSeek 文档写明）。所以对能关思考的服务商，请求里关掉它。
// 关不掉又要求回传的模型（Kimi 的 kimi-k3 / kimi-k2.7-code、Gemini 3 系列的 thought signature）不支持，控制台的
// 「测试连接」会用一轮带 tool 历史的请求把这个问题暴露出来。
//
// 出处（2026-09-30 核实）：
// - DeepSeek  https://api-docs.deepseek.com/guides/thinking_mode   思考默认开；关：{"thinking":{"type":"disabled"}}
// - 小米 MiMo https://mimo.mi.com/docs/en-US/api/chat/openai-api   思考默认开；关：{"thinking":{"type":"disabled"}}
// - Kimi      https://platform.kimi.ai/docs/guide/use-thinking-models  只有 kimi-k2.6 能关（同一参数）；
//             kimi-k3 不应传该参数、kimi-k2.7-code 传 disabled 会报错，所以只对 kimi-k2.6 加

type Quirk = {
  host: RegExp;
  model?: RegExp;
  body: Readonly<Record<string, unknown>>;
};

const THINKING_OFF = Object.freeze({ thinking: { type: "disabled" } });

const QUIRKS: readonly Quirk[] = Object.freeze([
  { host: /(^|\.)deepseek\.com$/, body: THINKING_OFF },
  { host: /(^|\.)xiaomimimo\.com$/, body: THINKING_OFF },
  {
    host: /(^|\.)moonshot\.(ai|cn)$/,
    model: /^kimi-k2\.6/,
    body: THINKING_OFF,
  },
]);

/** 该服务商 + 模型要额外带的请求体参数（浅合并进 chat completion 请求体）；不认识的服务商返回 {} */
export function providerParams(
  baseUrl: string,
  model: string,
): Readonly<Record<string, unknown>> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  const hit = QUIRKS.find(
    (q) => q.host.test(host) && (!q.model || q.model.test(model)),
  );
  return hit?.body ?? {};
}
