// /agent/audit 的实现：用审核提示词让模型只输出 { verdict, reason }。
//
// 语义（题目 2.2 / A5 第 4 条）：本服务只在拿到**明确结论**时回 200；上游失败、超时、模型输出解析不出 pass / fail
// 一律失败（app.ts 回 500）—— 后端对同一次工具调用最多重试 3 次，都拿不到就把 run 置 blocked。
// 不要把「解析失败」降级成 pass（放行没审过的内容）或 fail（把模型的格式问题算到内容头上）。
//
// 请求恒带 response_format: { type: "json_object" }（DeepSeek / Kimi 文档写明支持）；个别服务商不支持时，
// 控制台的「测试连接」会报出来。
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
): Record<string, unknown> {
  const model = target.auditModel ?? target.model;
  return {
    model,
    messages: [
      { role: "system", content: AUDIT_SYSTEM_PROMPT },
      { role: "user", content: auditUserMessage(input.text, input.groupId) },
    ],
    response_format: { type: "json_object" },
    ...providerParams(target.baseUrl, model),
  };
}

export async function runAudit(
  input: { text: string; groupId: string },
  target: LlmTarget,
  upstream: ChatClient,
  timeoutMs: number,
): Promise<AuditOutcome> {
  const outcome = await upstream.chat(target, auditRequestBody(input, target), {
    timeoutMs,
  });
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
