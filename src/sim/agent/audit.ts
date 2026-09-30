// /agent/audit 的行为：按 groupId（或默认）剧本逐次消费一步，渲染成响应并记录。
// 覆盖题目列出的全部审计坏行为：500 / 200 但非法 JSON / 无 verdict / verdict 是别的值 / 慢 / 不返回。
import type { Clock } from "../../core/clock.js";
import { auditStepForCall, type AuditStep } from "./scenario.js";
import type { AuditRecord, SimState } from "./turn.js";

const JSON_TYPE = "application/json; charset=utf-8";

export function renderAudit(
  step: AuditStep,
): NonNullable<AuditRecord["response"]> {
  const json = (value: unknown, status = 200) => ({
    status,
    contentType: JSON_TYPE,
    body: JSON.stringify(value),
  });
  switch (step.mode) {
    case "pass":
      return json({ verdict: "pass", reason: step.reason ?? "内容合规" });
    case "fail":
      return json({ verdict: "fail", reason: step.reason ?? "内容不合规" });
    case "http_500":
      return json(
        {
          error: {
            code: "INTERNAL",
            message: step.reason ?? "模拟的审计服务内部错误",
          },
        },
        step.status ?? 500,
      );
    case "invalid_json":
      return { status: 200, contentType: JSON_TYPE, body: '{"verdict": pass' };
    case "no_verdict":
      return json({ reason: step.reason ?? "审计完成" });
    case "other_verdict":
      return json({
        verdict: step.verdict ?? "maybe",
        reason: step.reason ?? "拿不准",
      });
  }
}

/** 处理一次 /agent/audit：选步骤、渲染、记录。调用方按 record.hang / delayMs 决定何时回复。 */
export function beginAudit(
  state: SimState,
  clock: Clock,
  groupId: string,
  text: string,
): { record: AuditRecord; step: AuditStep } {
  const { scenario, n } = state.nextAuditCall(groupId);
  const step = auditStepForCall(scenario, n);
  const record: AuditRecord = {
    seq: state.audits.length + 1,
    receivedAt: clock.now().toISOString(),
    groupId,
    text,
    mode: step.mode,
    response: step.hang ? null : renderAudit(step),
    delayMs: step.delay_ms ?? 0,
    hang: step.hang === true,
    responded: false,
  };
  state.audits.push(record);
  return { record, step };
}
