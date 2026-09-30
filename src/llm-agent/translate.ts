// 协议转换（纯函数，无 IO）：题目 2.2 的 Anthropic tool use 形状 ↔ OpenAI Chat Completions 兼容格式。
//
// 方向一（请求）：Anthropic 的 tools / messages → OpenAI 的 tools / messages（前置系统提示词）。
// 方向二（响应）：OpenAI 的 chat completion → 2.2 的一轮响应，**每轮恰好一个块**。
// 另有：/agent/turn 请求体与 tools 的校验（400 VALIDATION_ERROR / TOOLS_INVALID，与模拟器同语义）、
// 审计模型输出的解析。
import { randomUUID } from "node:crypto";

import { z } from "zod";

// ---- 2.2 协议（Anthropic 形状）------------------------------------------------------------

export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicBlock =
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
    };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicBlock[];
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

// ---- OpenAI Chat Completions（只用到的子集）-------------------------------------------------

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
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

// ---- 方向一：Anthropic → OpenAI ------------------------------------------------------------

export function toOpenAiTools(tools: readonly AnthropicTool[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** tool_result 的 content 按 2.2 是 JSON 串；Anthropic 也允许块数组，兜底拼成字符串 */
function resultText(content: unknown): string {
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

/** 没有配对 tool 消息的 tool_call 补的占位结果（正常历史里不会出现，防上游 400） */
const MISSING_RESULT = JSON.stringify({
  code: "NO_RESULT",
  message: "这次工具调用没有返回结果",
});

/**
 * messages → OpenAI messages（最前面是系统提示词）。
 * - user 的 text 块 → user 消息（第一条是触发上下文 JSON 串，原样给模型；`PROTOCOL_ERROR …` 也走这里）。
 *   相邻的 user 文本合并成一条：连续协议错误时历史里会出现 user、user 相连，有的服务商拒绝同角色相邻。
 * - assistant 的 tool_use 块 → assistant 消息的 tool_calls（arguments = JSON.stringify(input)）。
 *   content 给 null 而不是 ""：OpenAI 规范写明有 tool_calls 时 content 可为 null，官方 SDK 回放模型消息时
 *   也是 null；而空串在个别服务商那里会被判为「assistant 消息为空」拒绝。
 * - user 的 tool_result 块 → role: "tool"，tool_call_id = tool_use_id；is_error 时加一句前缀让模型知道这是失败。
 *   只有紧跟在带该 id 的 assistant 消息后面的 tool_result 才能这样转（OpenAI 要求 tool 消息回应前一条的
 *   tool_calls）；配不上的降级成 user 文本。反过来，没收到结果的 tool_call 补一条占位 tool 消息。
 */
export function toOpenAiMessages(
  messages: readonly AnthropicMessage[],
  systemPrompt: string,
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
  /** 上一条 assistant 消息里还没收到结果的 tool_call id */
  let pending: string[] = [];

  const flushPending = (): void => {
    for (const id of pending) {
      out.push({ role: "tool", tool_call_id: id, content: MISSING_RESULT });
    }
    pending = [];
  };
  const pushUserText = (text: string): void => {
    flushPending();
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      last.content = `${last.content}\n\n${text}`;
      return;
    }
    out.push({ role: "user", content: text });
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      flushPending();
      const texts: string[] = [];
      const calls: OpenAiToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "text") texts.push(block.text);
        else if (block.type === "tool_use") {
          calls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }
      const text = texts.join("\n");
      if (calls.length > 0) {
        out.push({
          role: "assistant",
          content: text === "" ? null : text,
          tool_calls: calls,
        });
        pending = calls.map((c) => c.id);
      } else if (text !== "") {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }

    // 先 tool_result 后 text：tool 消息必须紧跟 assistant 的 tool_calls，同一条 user 消息里混了文本也不打断配对
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const body = resultText(block.content);
        const content =
          block.is_error === true
            ? `工具调用失败（is_error=true），错误详情：${body}`
            : body;
        if (pending.includes(block.tool_use_id)) {
          out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
          pending = pending.filter((id) => id !== block.tool_use_id);
        } else {
          pushUserText(`工具调用 ${block.tool_use_id} 的结果：${content}`);
        }
      }
    }
    for (const block of message.content) {
      if (block.type === "text") pushUserText(block.text);
    }
  }
  flushPending();
  return out;
}

// ---- 方向二：OpenAI → Anthropic ------------------------------------------------------------

/** end_turn 且模型没给文字时的 summary */
export const DEFAULT_END_SUMMARY = "模型没有给出总结，本次处理已结束。";

/** 历史里出现过的全部 tool_use.id（生成新 id 时避开） */
export function historyToolUseIds(
  messages: readonly AnthropicMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) if (b.type === "tool_use") ids.add(b.id);
  }
  return ids;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw; // 个别服务商直接给对象
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * chat completion → 2.2 的一轮响应；形状不对（没有 choices[0].message）返回 null，由调用方回 502。
 *
 * - tool_calls 非空 → 只取**第一个**：2.2 规定合法响应每轮恰好一个块。请求里不带 parallel_tool_calls
 *   （有的服务商不认这个字段），由这里兜底；丢掉的调用模型下一轮会重新决定。
 * - arguments 不是合法 JSON（或不是对象）→ 仍返回 tool_use，input = {}。不回 5xx：5xx 在后端记 BAD_JSON，
 *   模型只看到一句「协议错误」；而 {} 会被后端按 input_schema 判 INVALID_INPUT、把具体缺哪个字段作为
 *   tool_result 回灌，模型下一轮有机会自己改对。
 * - tool_call.id 缺失、或与历史里的 tool_use.id 重复（有的服务商按轮次编号，跨轮会撞）→ 生成新 id：
 *   后端把重复 id 判为 DUPLICATE_TOOL_USE_ID 协议错误，而 id 只是历史里配对用的，换掉不影响语义。
 * - 无 tool_calls → end_turn，text = message.content（空时给 DEFAULT_END_SUMMARY）。
 * - 思考类模型的 reasoning_content 不回传（2.2 的块里没有它的位置）。
 */
export function fromOpenAiCompletion(
  completion: unknown,
  usedIds: ReadonlySet<string>,
  newId: () => string = () => `call_${randomUUID().replace(/-/g, "")}`,
): TurnResponse | null {
  if (!isRecord(completion) || !Array.isArray(completion.choices)) return null;
  const choice: unknown = completion.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const message = choice.message;

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first: unknown = calls[0];
  if (isRecord(first) && isRecord(first.function)) {
    const fn = first.function;
    const name = typeof fn.name === "string" ? fn.name : "";
    const upstreamId = typeof first.id === "string" ? first.id : "";
    const id =
      upstreamId !== "" && !usedIds.has(upstreamId) ? upstreamId : newId();
    return {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id, name, input: parseArguments(fn.arguments) },
      ],
    };
  }

  const text =
    typeof message.content === "string" ? message.content.trim() : "";
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: text === "" ? DEFAULT_END_SUMMARY : text }],
  };
}

// ---- 审计 ------------------------------------------------------------------------------------

export type AuditVerdict = { verdict: "pass" | "fail"; reason: string };

/** 审计输入给模型的 user 消息：原样交出 text 与 groupId，由系统提示词说明两种形态 */
export function auditUserMessage(text: string, groupId: string): string {
  return JSON.stringify({ groupId, text });
}

/**
 * 模型输出 → 审计结论；拿不到明确结论返回 null（调用方回 500，后端按 2.2 重试、最多 3 次后 blocked）。
 * 对**模型**宽容一点：剥掉一层 markdown 代码围栏再 JSON.parse（没开 JSON 模式的服务商常这样包）。
 * 对**后端**严格：本服务自己的响应永远是合法 JSON。
 */
/**
 * 从模型正文里取出一个 JSON 对象：整段就是 JSON / 包在 ``` 围栏里 / 前后夹着说明文字（没开 JSON 模式时常见）
 * 三种都认；都不是返回 null。只取第一个 `{` 到最后一个 `}` 之间的片段，不做更激进的修复。
 */
function parseJsonObjectLoosely(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidates = [fenced?.[1] ?? trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start)
    candidates.push(trimmed.slice(start, end + 1));
  for (const text of candidates) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

export function parseAuditVerdict(completion: unknown): AuditVerdict | null {
  if (!isRecord(completion) || !Array.isArray(completion.choices)) return null;
  const choice: unknown = completion.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const content = choice.message.content;
  if (typeof content !== "string") return null;
  const parsed = parseJsonObjectLoosely(content);
  if (!isRecord(parsed)) return null;
  const { verdict, reason } = parsed;
  if (verdict !== "pass" && verdict !== "fail") return null;
  return {
    verdict,
    reason:
      typeof reason === "string" && reason.trim() !== ""
        ? reason.trim()
        : "模型没有给出理由",
  };
}
