// /agent/turn 的会话状态机：按 runId 记第几轮、发过哪些 tool_use.id / idempotency_key、看到过哪些 tool_result，
// 并把剧本里的一步渲染成 HTTP 响应（状态码 + 原始字符串体）。
//
// 状态放在 SimState 实例里（由 buildAgentApp 创建、随 app 生命周期），不放模块顶层：模拟器是独立进程，
// 但测试里会同时起多个实例。tools 校验也在这里（validateTools），纯函数。
import type { Clock } from "../../core/clock.js";
import {
  DEFAULT_AUDIT_SCENARIO,
  DEFAULT_TURN_SCENARIO,
  TOOL_NAMES,
  TOOL_PARAMS,
  stepForTurn,
  type AuditScenario,
  type ToolName,
  type TurnScenario,
  type TurnStep,
} from "./scenario.js";

// ---------------------------------------------------------------------------
// tools 校验（题目：必须恰好是 4 个；input_schema 合法 JSON Schema 且 required 覆盖全部入参，否则 400 TOOLS_INVALID）
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 返回问题清单；空数组 = 合法 */
export function validateTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return ["tools 必须是数组"];
  const issues: string[] = [];
  if (tools.length !== 4) {
    issues.push(`tools 必须恰好 4 个，收到 ${tools.length} 个`);
  }
  const seen = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const where = `tools[${index}]`;
    if (!isRecord(tool)) {
      issues.push(`${where} 不是对象`);
      continue;
    }
    const name = tool.name;
    if (typeof name !== "string" || !(name in TOOL_PARAMS)) {
      issues.push(
        `${where}.name 不合法：${JSON.stringify(name)}（只认 ${TOOL_NAMES.join(" / ")}）`,
      );
      continue;
    }
    if (seen.has(name)) {
      issues.push(`${where}.name 重复：${name}`);
      continue;
    }
    seen.add(name);
    if (typeof tool.description !== "string" || tool.description === "") {
      issues.push(`${where}.description 必须是非空字符串`);
    }
    issues.push(
      ...validateInputSchema(where, name as ToolName, tool.input_schema),
    );
  }
  for (const name of TOOL_NAMES) {
    if (!seen.has(name) && tools.length === 4) issues.push(`缺少工具 ${name}`);
  }
  return issues;
}

function validateInputSchema(
  where: string,
  name: ToolName,
  schema: unknown,
): string[] {
  const issues: string[] = [];
  const expected = TOOL_PARAMS[name] as Record<string, readonly string[]>;
  if (!isRecord(schema)) return [`${where}.input_schema 必须是对象`];
  if (schema.type !== "object") {
    issues.push(`${where}.input_schema.type 必须是 "object"`);
  }
  const props = schema.properties;
  if (!isRecord(props)) {
    issues.push(`${where}.input_schema.properties 必须是对象`);
    return issues;
  }
  for (const [param, types] of Object.entries(expected)) {
    const prop = props[param];
    if (!isRecord(prop)) {
      issues.push(`${where}.input_schema.properties 缺少 ${param}`);
      continue;
    }
    if (typeof prop.type !== "string" || !types.includes(prop.type)) {
      issues.push(
        `${where}.input_schema.properties.${param}.type 应为 ${types.join(" / ")}，收到 ${JSON.stringify(prop.type)}`,
      );
    }
  }
  for (const extra of Object.keys(props)) {
    if (!(extra in expected)) {
      issues.push(`${where}.input_schema.properties 多出 ${extra}（入参固定）`);
    }
  }
  const required = schema.required;
  if (!Array.isArray(required)) {
    issues.push(`${where}.input_schema.required 必须是数组`);
    return issues;
  }
  for (const param of Object.keys(expected)) {
    if (!required.includes(param)) {
      issues.push(`${where}.input_schema.required 未覆盖 ${param}`);
    }
  }
  for (const req of required) {
    if (typeof req !== "string" || !(req in expected)) {
      issues.push(
        `${where}.input_schema.required 含未知入参 ${JSON.stringify(req)}`,
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

export interface SeenToolResult {
  tool_use_id: string;
  /** 从同一份 messages 里的 assistant tool_use 块反查；查不到为 null */
  name: string | null;
  is_error: boolean;
  content: unknown;
}

export interface RenderedResponse {
  /** 剧本步骤的 type */
  kind: string;
  status: number;
  contentType: string;
  body: string;
}

export interface TurnRecord {
  turn: number;
  receivedAt: string;
  messages: unknown[];
  /** 这一轮请求里带的 tool_result 块 */
  toolResults: SeenToolResult[];
  /** 剧本决定的响应；hang 时永远 pending */
  response: RenderedResponse | null;
  delayMs: number;
  hang: boolean;
  /** 已经返回给调用方（延迟已过） */
  responded: boolean;
}

export interface RunSession {
  runId: string;
  turns: number;
  requests: TurnRecord[];
  /** 本 run 发出过的 tool_use.id（含坏形状响应里的） */
  toolUseIds: string[];
  /** 本 run 的 send_message 用过的 idempotency_key，按发出顺序 */
  sendKeys: string[];
  /** 本 run 见过的全部 tool_result（按 tool_use_id 去重，后来的覆盖） */
  seenToolResults: SeenToolResult[];
}

export interface AuditRecord {
  seq: number;
  receivedAt: string;
  groupId: string;
  text: string;
  mode: string;
  response: { status: number; contentType: string; body: string } | null;
  delayMs: number;
  hang: boolean;
  responded: boolean;
}

/** 整个模拟器的可变状态：会话、剧本、审计记录。POST /_sim/reset 整个换新。 */
export class SimState {
  readonly runs = new Map<string, RunSession>();
  readonly audits: AuditRecord[] = [];
  turnDefault: TurnScenario = DEFAULT_TURN_SCENARIO;
  readonly turnByRun = new Map<string, TurnScenario>();
  auditDefault: AuditScenario = DEFAULT_AUDIT_SCENARIO;
  readonly auditByGroup = new Map<string, AuditScenario>();
  /** 默认 audit 剧本的游标（各 groupId 没有专属剧本时共用一条序列） */
  auditDefaultCalls = 0;
  readonly auditCallsByGroup = new Map<string, number>();

  /** POST /_sim/reset：会话、剧本、审计记录全部清空，回到默认剧本 */
  reset(): void {
    this.runs.clear();
    this.audits.length = 0;
    this.turnDefault = DEFAULT_TURN_SCENARIO;
    this.turnByRun.clear();
    this.auditDefault = DEFAULT_AUDIT_SCENARIO;
    this.auditByGroup.clear();
    this.auditDefaultCalls = 0;
    this.auditCallsByGroup.clear();
  }

  session(runId: string): RunSession {
    let s = this.runs.get(runId);
    if (!s) {
      s = {
        runId,
        turns: 0,
        requests: [],
        toolUseIds: [],
        sendKeys: [],
        seenToolResults: [],
      };
      this.runs.set(runId, s);
    }
    return s;
  }

  turnScenario(runId: string): TurnScenario {
    return this.turnByRun.get(runId) ?? this.turnDefault;
  }

  /** 取 groupId 对应的剧本，并推进相应游标；返回这是该序列的第几次调用 */
  nextAuditCall(groupId: string): { scenario: AuditScenario; n: number } {
    const own = this.auditByGroup.get(groupId);
    if (own) {
      const n = (this.auditCallsByGroup.get(groupId) ?? 0) + 1;
      this.auditCallsByGroup.set(groupId, n);
      return { scenario: own, n };
    }
    this.auditDefaultCalls += 1;
    return { scenario: this.auditDefault, n: this.auditDefaultCalls };
  }
}

// ---------------------------------------------------------------------------
// 从请求的 messages 里提取 tool_result
// ---------------------------------------------------------------------------

export function extractToolResults(messages: unknown[]): SeenToolResult[] {
  const names = new Map<string, string>();
  const results: SeenToolResult[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        names.set(block.id, block.name);
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        results.push({
          tool_use_id: block.tool_use_id,
          name: names.get(block.tool_use_id) ?? null,
          is_error: block.is_error === true,
          content: block.content,
        });
      }
    }
  }
  return results;
}

function mergeSeen(session: RunSession, fresh: SeenToolResult[]): void {
  const byId = new Map(session.seenToolResults.map((r) => [r.tool_use_id, r]));
  for (const r of fresh) byId.set(r.tool_use_id, r);
  session.seenToolResults = [...byId.values()];
}

// ---------------------------------------------------------------------------
// 把剧本的一步渲染成响应
// ---------------------------------------------------------------------------

const JSON_TYPE = "application/json; charset=utf-8";

type Block = Record<string, unknown>;

const json = (
  kind: string,
  value: unknown,
  status = 200,
): RenderedResponse => ({
  kind,
  status,
  contentType: JSON_TYPE,
  body: JSON.stringify(value),
});

const toolUse = (id: string, name: string, input: unknown): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});

function newToolUseId(session: RunSession): string {
  const id = `tu_${session.toolUseIds.length + 1}`;
  session.toolUseIds.push(id);
  return id;
}

function toolUseResponse(
  kind: string,
  session: RunSession,
  name: string,
  input: unknown,
  id = newToolUseId(session),
  stopReason = "tool_use",
): RenderedResponse {
  return json(kind, {
    stop_reason: stopReason,
    content: [toolUse(id, name, input)],
  });
}

/** 入参不合 schema 的样例（类型错 / 缺必填） */
const INVALID_INPUTS: Record<ToolName, unknown> = {
  get_recent_messages: { limit: "ten" },
  send_message: { text: 123 },
  kick_user: { platform_user_id: 42 },
  finish: {},
};

const VALID_END_TURN = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "无需回复。" }],
};

/**
 * 渲染第 turn 轮的响应，并把发出的 tool_use.id / idempotency_key 记进会话。
 * 纯函数（除了改 session）：不睡眠、不发 HTTP。
 */
export function renderStep(
  step: TurnStep,
  session: RunSession,
  turn: number,
): RenderedResponse {
  switch (step.type) {
    case "get_recent_messages":
      return toolUseResponse(step.type, session, "get_recent_messages", {
        limit: step.limit ?? 10,
      });
    case "send_message": {
      const last = session.sendKeys[session.sendKeys.length - 1];
      const key =
        step.idempotency_key ??
        (step.reuse_key && last !== undefined
          ? last
          : `k-${session.runId}-${session.sendKeys.length + 1}`);
      session.sendKeys.push(key);
      return toolUseResponse(step.type, session, "send_message", {
        text: step.text ?? `自动回复（第 ${turn} 轮）`,
        idempotency_key: key,
      });
    }
    case "kick_user":
      return toolUseResponse(step.type, session, "kick_user", {
        platform_user_id: step.platform_user_id ?? "u-spam",
        reason: step.reason ?? "违规内容",
      });
    case "finish":
      return toolUseResponse(step.type, session, "finish", {
        summary: step.summary ?? `已处理（共 ${turn} 轮）`,
      });
    case "end_turn":
      return json(step.type, {
        stop_reason: "end_turn",
        content: [{ type: "text", text: step.text ?? "无需回复。" }],
      });
    case "tool_use": {
      const id = step.id ?? newToolUseId(session);
      if (step.id !== undefined) session.toolUseIds.push(step.id);
      if (step.name === "send_message" && step.input) {
        const key = step.input.idempotency_key;
        if (typeof key === "string") session.sendKeys.push(key);
      }
      return toolUseResponse(
        step.type,
        session,
        step.name,
        step.input ?? {},
        id,
        step.stop_reason ?? "tool_use",
      );
    }
    case "unknown_tool":
      return toolUseResponse(step.type, session, step.name ?? "delete_group", {
        groupId: session.runId,
      });
    case "invalid_input": {
      const name = step.name ?? "get_recent_messages";
      return toolUseResponse(step.type, session, name, INVALID_INPUTS[name]);
    }
    case "duplicate_id": {
      const id = session.toolUseIds[session.toolUseIds.length - 1] ?? "tu_1";
      session.toolUseIds.push(id);
      return toolUseResponse(
        step.type,
        session,
        "get_recent_messages",
        { limit: 10 },
        id,
      );
    }
    case "huge_limit":
      return toolUseResponse(step.type, session, "get_recent_messages", {
        limit: 100000,
      });
    case "invalid_json":
      return {
        kind: step.type,
        status: 200,
        contentType: JSON_TYPE,
        body: '{"stop_reason": "tool_use", "content": [{"type": "tool_use",',
      };
    case "markdown_fenced":
      return {
        kind: step.type,
        status: 200,
        contentType: JSON_TYPE,
        body: "```json\n" + JSON.stringify(VALID_END_TURN) + "\n```",
      };
    case "wrapped_text":
      return {
        kind: step.type,
        status: 200,
        contentType: JSON_TYPE,
        body: `好的，我的回复如下：\n${JSON.stringify(VALID_END_TURN)}\n希望这有帮助。`,
      };
    case "missing_stop_reason":
      return json(step.type, {
        content: [
          toolUse(newToolUseId(session), "get_recent_messages", { limit: 10 }),
        ],
      });
    case "no_blocks":
      return json(step.type, { stop_reason: "end_turn", content: [] });
    case "two_blocks":
      return json(step.type, {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "先看看最近的消息。" },
          toolUse(newToolUseId(session), "get_recent_messages", { limit: 10 }),
        ],
      });
    case "stop_reason_mismatch":
      return json(step.type, {
        stop_reason: "end_turn",
        content: [
          toolUse(newToolUseId(session), "get_recent_messages", { limit: 10 }),
        ],
      });
    case "http_error":
      return {
        kind: step.type,
        status: step.status ?? 500,
        contentType: JSON_TYPE,
        body:
          step.body ??
          JSON.stringify({
            error: { code: "INTERNAL", message: "模拟的 Agent 服务内部错误" },
          }),
      };
    case "raw":
      return {
        kind: step.type,
        status: step.status ?? 200,
        contentType: step.content_type ?? JSON_TYPE,
        body: step.body,
      };
  }
}

/**
 * 处理一轮 /agent/turn（tools 已校验通过）：推进会话、选步骤、渲染响应、记录。
 * 返回记录本身；调用方按 record.hang / record.delayMs 决定何时真正回复。
 */
export function beginTurn(
  state: SimState,
  clock: Clock,
  runId: string,
  messages: unknown[],
): { session: RunSession; record: TurnRecord; step: TurnStep } {
  const session = state.session(runId);
  session.turns += 1;
  const turn = session.turns;
  const toolResults = extractToolResults(messages);
  mergeSeen(session, toolResults);
  const step = stepForTurn(state.turnScenario(runId), turn);
  const record: TurnRecord = {
    turn,
    receivedAt: clock.now().toISOString(),
    messages,
    toolResults,
    response: step.hang ? null : renderStep(step, session, turn),
    delayMs: step.delay_ms ?? 0,
    hang: step.hang === true,
    responded: false,
  };
  session.requests.push(record);
  return { session, record, step };
}
