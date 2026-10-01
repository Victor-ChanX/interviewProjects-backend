// 题目 2.2 的协议面（纯函数，无 IO）：/agent/turn、/agent/audit 的请求校验与类型、每轮恰好一个块的响应、
// 审计结论的严格解析。上游（Claude / Gemini）各自的翻译在 anthropic.ts / gemini.ts。
import { randomUUID } from "node:crypto";

import { z } from "zod";

// ---- 2.2 协议（Anthropic tool use 形状）----------------------------------------------------

export type AgentTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AgentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    }
  | {
      /** 触发消息里的图片（后端 #61 在协议上扩的块）：转成上游各自的图片输入 */
      type: "image";
      msgId?: string;
      source: { type: "base64"; media_type: string; data: string };
    };

export type AgentMessage = {
  role: "user" | "assistant";
  content: AgentBlock[];
};

export type TurnResponse =
  | {
      stop_reason: "tool_use";
      content: [
        {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        },
      ];
    }
  | { stop_reason: "end_turn"; content: [{ type: "text"; text: string }] };

export type AuditVerdict = { verdict: "pass" | "fail"; reason: string };

// ---- 请求校验 --------------------------------------------------------------------------------

/** 题目 2.2 规定的 4 个工具 */
export const TOOL_NAMES = [
  "get_recent_messages",
  "send_message",
  "kick_user",
  "finish",
] as const;

const Block = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
  z.looseObject({
    type: z.literal("tool_result"),
    tool_use_id: z.string().min(1),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal("image"),
    msgId: z.string().optional(),
    source: z.object({
      type: z.literal("base64"),
      media_type: z.string().min(1),
      data: z.string().min(1),
    }),
  }),
]);

export const TurnRequest = z.looseObject({
  runId: z.string().min(1),
  tools: z.unknown(),
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant"]),
        content: z.array(Block),
      }),
    )
    .min(1),
});

export const AuditRequest = z.looseObject({
  text: z.string(),
  groupId: z.string().min(1),
});

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * tools 校验（题目：恰好 4 个、名字固定、input_schema 是 type=object 的 JSON Schema 且 required 覆盖全部入参）。
 * 返回问题清单，空数组 = 合法。比模拟器宽一点：不核对每个参数的 type —— 本服务只负责把 schema 原样交给模型。
 */
export function validateTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ["tools 必须是数组"];
  const issues: string[] = [];
  if (tools.length !== TOOL_NAMES.length) {
    issues.push(
      `tools 必须恰好 ${TOOL_NAMES.length} 个，收到 ${tools.length} 个`,
    );
  }
  const seen = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const where = `tools[${index}]`;
    if (!isRecord(tool)) {
      issues.push(`${where} 不是对象`);
      continue;
    }
    const { name, description, input_schema: schema } = tool;
    if (
      typeof name !== "string" ||
      !(TOOL_NAMES as readonly string[]).includes(name)
    ) {
      issues.push(`${where}.name 不合法：${JSON.stringify(name)}`);
      continue;
    }
    if (seen.has(name)) issues.push(`${where}.name 重复：${name}`);
    seen.add(name);
    if (typeof description !== "string" || description === "") {
      issues.push(`${where}.description 必须是非空字符串`);
    }
    if (!isRecord(schema) || schema.type !== "object") {
      issues.push(`${where}.input_schema 必须是 type 为 "object" 的对象`);
      continue;
    }
    const props = isRecord(schema.properties) ? schema.properties : null;
    if (!props) {
      issues.push(`${where}.input_schema.properties 必须是对象`);
      continue;
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of Object.keys(props)) {
      if (!required.includes(key)) {
        issues.push(`${where}.input_schema.required 未覆盖 ${key}`);
      }
    }
  }
  for (const name of TOOL_NAMES) {
    if (!seen.has(name)) issues.push(`缺少工具 ${name}`);
  }
  return issues;
}

// ---- 响应 ------------------------------------------------------------------------------------

/** end_turn 且模型没给文字时的 summary */
export const DEFAULT_END_SUMMARY = "模型没有给出总结，本次处理已结束。";

export function toolUseResponse(block: {
  id: string;
  name: string;
  input: Record<string, unknown>;
}): TurnResponse {
  return {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: block.id, name: block.name, input: block.input },
    ],
  };
}

export function endTurnResponse(text: string): TurnResponse {
  const trimmed = text.trim();
  return {
    stop_reason: "end_turn",
    content: [
      { type: "text", text: trimmed === "" ? DEFAULT_END_SUMMARY : trimmed },
    ],
  };
}

/** 历史里出现过的全部 tool_use.id（上游没给 id 或给了重复 id 时，生成新 id 要避开它们） */
export function historyToolUseIds(
  messages: readonly AgentMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) if (b.type === "tool_use") ids.add(b.id);
  }
  return ids;
}

/**
 * 给 tool_use 定 id：上游给了且与历史不重复就用上游的，否则生成一个。
 * 后端把重复 id 判为 DUPLICATE_TOOL_USE_ID 协议错误；id 只在历史里配对用，换掉不影响语义。
 */
export function pickToolUseId(
  upstreamId: string | undefined,
  used: ReadonlySet<string>,
): string {
  if (upstreamId && !used.has(upstreamId)) return upstreamId;
  return `call_${randomUUID().replace(/-/g, "")}`;
}

/** tool_result 的 content 按 2.2 是 JSON 串；也允许块数组，统一成字符串 */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        isRecord(b) && typeof b.text === "string" ? b.text : JSON.stringify(b),
      )
      .join("\n");
  }
  return JSON.stringify(content ?? null);
}

// ---- 审计 ------------------------------------------------------------------------------------

/** 审计输入给模型的 user 消息：原样交出 text 与 groupId，由系统提示词说明两种形态 */
export function auditUserMessage(text: string, groupId: string): string {
  return JSON.stringify({ groupId, text });
}

/** 审计的结构化输出 schema：Claude 的 output_config.format 与 Gemini 的 responseJsonSchema 共用 */
export const VERDICT_JSON_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      reason: { type: "string" },
    },
    required: ["verdict", "reason"],
    additionalProperties: false,
  });

/**
 * 结构化输出的正文 → 审计结论；拿不到明确结论返回 null（调用方回 500，后端按 2.2 重试、最多 3 次后 blocked）。
 * 上游已经按 schema 约束了输出，这里只做严格的 JSON.parse + 形状检查，不剥代码围栏、不从正文里抠 JSON：
 * 约束之下还拿不到合法结论，说明这次输出不可信（被截断、被拒绝），不该猜。
 */
export function parseVerdict(text: string): AuditVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { verdict, reason } = parsed;
  if (verdict !== "pass" && verdict !== "fail") return null;
  if (typeof reason !== "string") return null;
  return {
    verdict,
    reason: reason.trim() === "" ? "模型没有给出理由" : reason.trim(),
  };
}
