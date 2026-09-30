// /agent/audit 的实现：用审核提示词让模型只输出 { verdict, reason }。
//
// 语义（题目 2.2 / A5 第 4 条）：本服务只在拿到**明确结论**时回 200；上游失败、超时、模型输出解析不出 pass / fail
// 一律失败（app.ts 回 500）—— 后端对同一次工具调用最多重试 3 次，都拿不到就把 run 置 blocked。
// 不要把「解析失败」降级成 pass（放行没审过的内容）或 fail（把模型的格式问题算到内容头上）。
//
// 先带 response_format: { type: "json_object" } 请求（DeepSeek / Kimi 文档写明支持）。服务商拒绝这个参数
// （4xx）时在剩余时间内去掉它重试一次，靠审核提示词与宽松解析（从正文里取出 JSON 对象）拿结论 ——
// 不是每家都支持 JSON 模式，但都能按提示词输出一段 JSON。
import type { LlmTarget } from "./config-store.js";
import type { ChatClient } from "./openai-client.js";
import { AUDIT_SYSTEM_PROMPT } from "./prompts.js";
import { providerParams } from "./providers.js";
import {
  auditUserMessage,
  parseAuditVerdict,
  type AuditVerdict,
} from "./translate.js";

export type AuditOutcome =
  | { ok: true; result: AuditVerdict; attempts: number; elapsedMs: number }
  | { ok: false; reason: string; attempts: number; elapsedMs: number };

/** 上游请求体（导出给测试断言形状） */
export function auditRequestBody(
  input: { text: string; groupId: string },
  target: LlmTarget,
  opts: { jsonMode: boolean } = { jsonMode: true },
): Record<string, unknown> {
  const model = target.auditModel ?? target.model;
  return {
    model,
    messages: [
      { role: "system", content: AUDIT_SYSTEM_PROMPT },
      { role: "user", content: auditUserMessage(input.text, input.groupId) },
    ],
    ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...providerParams(target.baseUrl, model),
  };
}

/** 服务商拒绝请求参数（而不是限流 / 故障）时的状态码：这时去掉 JSON 模式再试一次才有意义 */
const PARAM_REJECTED = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 422;

export async function runAudit(
  input: { text: string; groupId: string },
  target: LlmTarget,
  upstream: ChatClient,
  timeoutMs: number,
): Promise<AuditOutcome> {
  let outcome = await upstream.chat(target, auditRequestBody(input, target), {
    timeoutMs,
  });
  if (!outcome.ok && PARAM_REJECTED(outcome.status)) {
    const remaining = timeoutMs - outcome.elapsedMs;
    if (remaining > 0) {
      const first = outcome;
      const retry = await upstream.chat(
        target,
        auditRequestBody(input, target, { jsonMode: false }),
        { timeoutMs: remaining },
      );
      outcome = {
        ...retry,
        attempts: first.attempts + retry.attempts,
        elapsedMs: first.elapsedMs + retry.elapsedMs,
      };
    }
  }
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
    };
  }
  const result = parseAuditVerdict(outcome.completion);
  if (!result) {
    return {
      ok: false,
      reason: "模型输出不是 { verdict: pass | fail, reason } 形状的 JSON",
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
    };
  }
  return {
    ok: true,
    result,
    attempts: outcome.attempts,
    elapsedMs: outcome.elapsedMs,
  };
}
