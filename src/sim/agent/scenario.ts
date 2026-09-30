// Agent 模拟器的「剧本」DSL：POST /_sim/scenario 的请求体形状、默认剧本、按轮次取步骤。
//
// 一个 turn 剧本 = 一串「轮次行为」（steps，第 i 步对应该 runId 的第 i 轮 /agent/turn）+ 步骤用完后的
// 兜底（fallback）。每步可以带 repeat（展开成连续多轮）、delay_ms（慢响应）、hang（永不返回）。
// 覆盖题目 2.2「Agent 服务可能出现的行为」列出的全部坏行为，每种一个 type；generic 的 `tool_use` 与 `raw`
// 兜住没列出的组合。audit 剧本同理（每次 /agent/audit 消费一步）。
//
// 这里只有纯数据与 zod 校验，不碰 fastify、不碰应用的 db / services。
import { z } from "zod";

/** 题目固定的 4 个工具及其入参（名字 → 参数名 → JSON Schema type） */
export const TOOL_PARAMS = {
  get_recent_messages: { limit: ["number", "integer"] },
  send_message: { text: ["string"], idempotency_key: ["string"] },
  kick_user: { platform_user_id: ["string"], reason: ["string"] },
  finish: { summary: ["string"] },
} as const;

export type ToolName = keyof typeof TOOL_PARAMS;
export const TOOL_NAMES = Object.keys(TOOL_PARAMS) as ToolName[];

/** 每步都能带的时序控制：先 hang（永不返回，直到进程 / app 关闭），否则 delay_ms 后再返回。 */
const timing = {
  delay_ms: z.number().int().nonnegative().optional(),
  hang: z.boolean().optional(),
  /** 同一步连续执行几轮（展开后按轮次取），默认 1 */
  repeat: z.number().int().positive().optional(),
};

export const TurnStep = z.discriminatedUnion("type", [
  // ---- 正常行为 ----
  z.object({
    type: z.literal("get_recent_messages"),
    limit: z.number().optional(),
    ...timing,
  }),
  z.object({
    type: z.literal("send_message"),
    text: z.string().optional(),
    /** 显式 key；不给则自动生成 `k-<runId>-<序号>` */
    idempotency_key: z.string().optional(),
    /** true：复用本 run 上一次 send_message 用过的 key（S5「拿到结果后用同一个 key 再调」） */
    reuse_key: z.boolean().optional(),
    ...timing,
  }),
  z.object({
    type: z.literal("kick_user"),
    platform_user_id: z.string().optional(),
    reason: z.string().optional(),
    ...timing,
  }),
  z.object({
    type: z.literal("finish"),
    summary: z.string().optional(),
    ...timing,
  }),
  z.object({
    type: z.literal("end_turn"),
    text: z.string().optional(),
    ...timing,
  }),
  /** 任意 tool_use 块：名字 / 入参 / id / stop_reason 全可指定，兜住没单列的组合 */
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    id: z.string().optional(),
    stop_reason: z.string().optional(),
    ...timing,
  }),
  // ---- 协议层坏行为（题目：调用不在 tools 里的工具 / 入参不符合 schema / 同一个 tool_use.id 用两次）----
  z.object({
    type: z.literal("unknown_tool"),
    name: z.string().optional(),
    ...timing,
  }),
  z.object({
    type: z.literal("invalid_input"),
    name: z.enum(TOOL_NAMES).optional(),
    ...timing,
  }),
  z.object({ type: z.literal("duplicate_id"), ...timing }),
  /** get_recent_messages { limit: 100000 } */
  z.object({ type: z.literal("huge_limit"), ...timing }),
  // ---- 响应体坏形状（题目：记为 BAD_JSON 的各种情况）----
  z.object({ type: z.literal("invalid_json"), ...timing }),
  z.object({ type: z.literal("markdown_fenced"), ...timing }),
  z.object({ type: z.literal("wrapped_text"), ...timing }),
  z.object({ type: z.literal("missing_stop_reason"), ...timing }),
  z.object({ type: z.literal("no_blocks"), ...timing }),
  z.object({ type: z.literal("two_blocks"), ...timing }),
  z.object({ type: z.literal("stop_reason_mismatch"), ...timing }),
  /** 非 2xx */
  z.object({
    type: z.literal("http_error"),
    status: z.number().int().min(300).max(599).optional(),
    body: z.string().optional(),
    ...timing,
  }),
  /** 原样返回给定字符串 */
  z.object({
    type: z.literal("raw"),
    status: z.number().int().min(100).max(599).optional(),
    body: z.string(),
    content_type: z.string().optional(),
    ...timing,
  }),
]);
export type TurnStep = z.infer<typeof TurnStep>;

/**
 * steps 用完之后：
 * - finish：返回 finish（默认，run 正常结束）
 * - loop_tools：永远返回 get_recent_messages { limit: 10 }（「一直调工具不结束」，靠应用的 12 步上限收口）
 * - repeat_last：永远重复最后一步（没有 steps 时等同 finish）
 */
export const TurnFallback = z.enum(["finish", "loop_tools", "repeat_last"]);
export type TurnFallback = z.infer<typeof TurnFallback>;

export const TurnScenario = z.object({
  steps: z.array(TurnStep).default([]),
  fallback: TurnFallback.default("finish"),
});
export type TurnScenario = z.infer<typeof TurnScenario>;

/** 默认剧本：第 1 轮 get_recent_messages { limit: 10 } → 第 2 轮 send_message → 第 3 轮起 finish */
export const DEFAULT_TURN_SCENARIO: TurnScenario = Object.freeze({
  steps: [{ type: "get_recent_messages", limit: 10 }, { type: "send_message" }],
  fallback: "finish",
}) as TurnScenario;

export const AuditMode = z.enum([
  "pass",
  "fail",
  "http_500",
  "invalid_json",
  "no_verdict",
  "other_verdict",
]);
export type AuditMode = z.infer<typeof AuditMode>;

export const AuditStep = z.object({
  mode: AuditMode.default("pass"),
  reason: z.string().optional(),
  /** other_verdict 时返回的 verdict 值，默认 "maybe" */
  verdict: z.string().optional(),
  /** http_500 时的状态码，默认 500 */
  status: z.number().int().min(300).max(599).optional(),
  ...timing,
});
export type AuditStep = z.infer<typeof AuditStep>;

export const AuditScenario = z.object({
  steps: z.array(AuditStep).default([]),
  /** steps 用完之后每次都返回这一步，默认 pass */
  fallback: AuditStep.default({ mode: "pass" }),
});
export type AuditScenario = z.infer<typeof AuditScenario>;

export const DEFAULT_AUDIT_SCENARIO: AuditScenario = Object.freeze({
  steps: [],
  fallback: { mode: "pass" },
});

/** POST /_sim/scenario 的请求体：turn 剧本按 runId（缺省 = 默认），audit 剧本按 groupId（缺省 = 默认） */
export const ScenarioRequest = z
  .object({
    runId: z.string().min(1).optional(),
    groupId: z.string().min(1).optional(),
    turn: TurnScenario.optional(),
    audit: AuditScenario.optional(),
  })
  .refine((v) => v.turn !== undefined || v.audit !== undefined, {
    message: "turn 与 audit 至少给一个",
  });
export type ScenarioRequest = z.infer<typeof ScenarioRequest>;

/** 把 repeat 展开成逐轮的平铺列表（repeat 字段留在步骤里不影响执行） */
export function expandSteps<T extends { repeat?: number | undefined }>(
  steps: readonly T[],
): T[] {
  const out: T[] = [];
  for (const step of steps) {
    for (let i = 0; i < (step.repeat ?? 1); i += 1) out.push(step);
  }
  return out;
}

/** 第 turn 轮（从 1 起）该执行哪一步 */
export function stepForTurn(scenario: TurnScenario, turn: number): TurnStep {
  const steps = expandSteps(scenario.steps);
  const step = steps[turn - 1];
  if (step) return step;
  const last = steps[steps.length - 1];
  switch (scenario.fallback) {
    case "loop_tools":
      return { type: "get_recent_messages", limit: 10 };
    case "repeat_last":
      return last ?? { type: "finish" };
    case "finish":
      return { type: "finish" };
  }
}

/** 第 n 次（从 1 起）审计该执行哪一步 */
export function auditStepForCall(
  scenario: AuditScenario,
  n: number,
): AuditStep {
  const steps = expandSteps(scenario.steps);
  return steps[n - 1] ?? scenario.fallback;
}
