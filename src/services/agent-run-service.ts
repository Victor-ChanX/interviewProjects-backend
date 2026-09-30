// Agent run（题目 2.2 协议 / 2.3 agent-runs 端点 / A5 全部 12 条 / S5 / S6；issue #12 + #13）。
//
// 一切从「进程随时会死、副本不止一个」出发：run 的全部状态在 agent_runs / agent_steps / agent_idempotency /
// agent_pending_messages 里，进程只是执行器。一次 /agent/turn 往返 = 一步；每一步**先落库再产生副作用**：
//   turn 返回 → 写 step 行（toolUseId / input / rawResponse）→ 执行工具 → 写结果。
// 重启后看到「有 step 行但没结果」的步就从中断处续：send_message 按 agent_idempotency 判有没有入过队（有 → 只等结果，
// 不再入队、不再审计），kick_user 按 toolStartedAt + 网关成员列表判有没有发过 kick（A5 第 8 条）。
//
// 触发（A5 第 1 条）onInboundMessage：入站 service 写入非自己消息的同一事务里调。同群至多一个 running 靠部分唯一索引
// agent_runs_one_running_per_group（20260930101643_domain_model）：INSERT … ON CONFLICT DO NOTHING，没插进去就是
// 已有 running → 写 agent_pending_messages。事务里先 SELECT … FOR SHARE 锁住 running 的那行：结束 run 的 UPDATE 要等
// 它提交，所以「pending 写进去了 run 却已经结束」不会发生；run 结束时（endRun）在同一事务里把 pending 合并成下一次
// run 的 triggerMessages。多副本并发触发同群：ON CONFLICT 让后来者等先到者提交，再按 running 走 pending。
//
// 上限（A5 第 2 条）：stepCount ≥ maxSteps（12，含结束那步）→ budget_exhausted；连续协议错误 ≥ 3 → protocol_errors；
// 墙钟 accumulatedMs + (now − activeSince) ≥ budgetMs（60s）→ wall_clock —— activeSince 在 worker 领取时设、释放 /
// 结束时折进 accumulatedMs，停机期间自然不计（worker.budget-from-db）。60 秒「从 run 创建起」算：第一次领取时把
// 创建到领取之间的排队时间也折进去（只算本 worker 启动之后的部分 —— 之前可能是停机）。心跳过期的 run 被别的副本
// 接手时只折算「心跳还活着」的那段。审计重试不计步但计时（它们发生在一步之内）。
// 重启续跑（A5 第 8 条）：有未完成的步就先把它续完，再判上限 / 外部状态 —— 否则第 12 步发出去之后崩溃，恢复时先判
// 「步数已满」就结束了，这一步的结果永远是空的。
//
// 协议错误（A5 第 3 条）：BAD_JSON / DUPLICATE_TOOL_USE_ID / TURN_TIMEOUT 不追加 assistant 块，记 kind=protocol_error
// 的步（resultContent = `PROTOCOL_ERROR <code>: <一句话>`，重建历史时作为 user text 块）；UNKNOWN_TOOL / INVALID_INPUT
// 正常追加 tool_use 块 + is_error 的 tool_result。两类都是协议错误（A5 第 3 条把它们列在一起，只是追加方式不同），
// 都让 consecutiveProtocolErrors + 1，连续 3 次 → protocol_errors；合法响应清零。
//
// 审计（A5 第 4 条）：send_message / kick_user 执行前 /agent/audit，只有合法 JSON 且 verdict 恰为 pass 才执行；fail →
// AUDIT_REJECTED；拿不到结论最多 3 次（auditAttempts 落库，先写后调；不计步、不返回 agent）→ run blocked（audit_blocked），
// 工具不执行，写 ws_events agent_run。
//
// 重复调用（A5 第 11 条，处理方式自定）：连续第 3 次及以后用相同入参调 get_recent_messages，仍返回真实结果（非 is_error，
// 期间新到的消息照样可见）但附 hint 说明入参没变、建议 send_message / finish。理由：入参本身合法，报 INVALID_INPUT 是
// 谎话；返回空列表是另一种谎话；12 步上限本身保证 run 一定结束（budget_exhausted），hint 只是让守规矩的模型早点收手。
//
// 执行账号（A5 第 5 条）：online 的群成员里 accountId 最小的（确定、可预期）；kick_user 要 role ∈ creator / admin，
// 群主优先。没有 → NO_AVAILABLE_ACCOUNT（计步、不算协议错）。
//
// 手写 SQL 用数据库列名（@map 的值），`${}` 是绑定参数。
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { type Clock, systemClock } from "../core/clock.js";
import { DomainError, NotFound } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type {
  AgentRun,
  AgentRunEndReason,
  AgentRunStatus,
  AgentStep,
  Group,
  Prisma,
} from "../db/generated/client.js";
import type {
  AgentClient,
  AgentMessage,
  AgentTool,
  ToolUseBlock,
} from "./agent-client.js";
import {
  type GatewayClient,
  GatewayResponseError,
  GatewayUnreachableError,
} from "./gateway-client.js";
import type { AgentRunListItem, AgentRunPage } from "../schemas/agent-run.js";
import {
  clampLimit,
  decodeTimeCursor,
  encodeTimeCursor,
  sliceCursorPage,
} from "./cursor.js";
import { enqueueMessageInTx } from "./outbox-service.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 常量（题目 2.2 / A5 的数字）--------------------------------------------------------------

/** A5 第 2 条：上限 12 步（含结束那步）；库里 agent_runs.max_steps 默认同值，这里只给新 run 与说明用 */
export const MAX_STEPS = 12;
export const CONSECUTIVE_PROTOCOL_ERRORS_LIMIT = 3;
/** A5 第 4 条：拿不到审计结论最多尝试 3 次 */
export const AUDIT_MAX_ATTEMPTS = 3;
/** 2.2 工具表：send_message 最多等 5 秒；等待期间按这个间隔轮询 messages 表 */
export const SEND_WAIT_MS = 5_000;
export const SEND_POLL_MS = 100;
/** 2.1：kick 返回 504 时用成员列表判断，网关保证 2 秒内收敛 */
export const KICK_CONVERGE_MS = 2_000;
export const KICK_POLL_MS = 250;
/** 2.2 工具表：get_recent_messages 的 limit 上限 50、单条 text 超过 500 字截断 */
export const RECENT_MESSAGES_MAX = 50;
export const RECENT_TEXT_MAX_CHARS = 500;
/** A5 第 9 条：tool_result content ≤ 8KB；resultSummary ≤ 200 字；2.3：rawResponse 截到 2KB */
export const RESULT_CONTENT_MAX_BYTES = 8 * 1024;
export const RESULT_SUMMARY_MAX_CHARS = 200;
export const RAW_RESPONSE_MAX_BYTES = 2 * 1024;
/** 心跳超过这么久没更新 = 执行者死了，别的副本可以接手（一步最长 ≈ turn 12s + 审计 3×5s + 等发送 5s） */
export const STALE_HEARTBEAT_MS = 60_000;
/** 连续用相同入参调 get_recent_messages 到第几次开始附 hint（A5 第 11 条） */
export const REPEATED_CALL_HINT_FROM = 3;

/** 题目 2.2 的错误 tool_result 码表 */
export const TOOL_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "INVALID_INPUT",
  "DUPLICATE_TOOL_USE_ID",
  "BAD_JSON",
  "TURN_TIMEOUT",
  "AUDIT_REJECTED",
  "POLICY_DENIED",
  "SEND_TIMEOUT",
  "SEND_FAILED",
  "NO_AVAILABLE_ACCOUNT",
  "GROUP_UNREACHABLE",
  "OWNER_LEFT",
  "NO_PERMISSION",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** 发给 /agent/turn 的 4 个工具（题目 2.2：必须恰好这 4 个，required 覆盖全部入参） */
export const AGENT_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: "get_recent_messages",
    description:
      "取该群最近的消息（按 sentAt 升序，含触发消息与 run 期间新到的消息）。limit 上限 50。",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "以某个服务账号往群里发一条消息。idempotency_key 相同的调用只发一次，之后返回那条消息的当前状态。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        idempotency_key: { type: "string", minLength: 1 },
      },
      required: ["text", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "kick_user",
    description:
      "把某个 platform_user_id 移出群（需要群开启 autoKickEnabled，且有群主 / 管理员账号在线）。",
    input_schema: {
      type: "object",
      properties: {
        platform_user_id: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      required: ["platform_user_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "结束本次处理，summary 是给操作员看的一句话总结。",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
]);

const TOOL_INPUT_SCHEMAS = {
  get_recent_messages: z.strictObject({ limit: z.number().int().min(1) }),
  send_message: z.strictObject({
    text: z.string().min(1),
    idempotency_key: z.string().min(1),
  }),
  kick_user: z.strictObject({
    platform_user_id: z.string().min(1),
    reason: z.string(),
  }),
  finish: z.strictObject({ summary: z.string() }),
} as const;
export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;

// ---- 类型 ------------------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;
type Db = Tx | ReturnType<typeof getDb>;
export type AgentLog = Pick<Logger, "info" | "warn" | "error">;

/** 触发消息快照（agent_runs.trigger_messages 的元素；也是 messages[0] 触发上下文里的形状） */
export type TriggerMessage = {
  msgId: string;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
};

/**
 * 测试用的「缝」：重启恢复用例在这些点上抛错模拟进程死亡（worker 的 tick 捕获后释放领取，新 tick 从库里续）。
 * 生产不传。
 */
export type Checkpoint =
  | "before_turn"
  | "after_turn_persisted"
  | "after_audit"
  | "after_enqueue"
  | "before_kick";

export type AgentRunDeps = {
  clock: Clock;
  log?: AgentLog;
  agent: AgentClient;
  gateway: GatewayClient;
  /** 领取标记 claimedBy 的值；多副本各不相同 */
  workerId: string;
  /** /agent/turn 每轮超时（题目：10–15s 可配）；默认 config.agentTurnTimeoutMs 由 worker 传 */
  turnTimeoutMs: number;
  auditTimeoutMs: number;
  /** 等待用（轮询 messages / 成员列表）；service 里不许 setTimeout，由 worker 注入，测试注入假的 */
  sleep: (ms: number) => Promise<void>;
  checkpoint?: (point: Checkpoint) => Promise<void>;
};

export type TriggerOutcome =
  | { kind: "run_created"; runId: string }
  | { kind: "pending"; runId: string }
  | {
      kind: "ignored";
      reason:
        "agent_disabled" | "group_inactive" | "own_message" | "no_message";
    };

/** runStep 的结果：continue = run 仍 running、可以再跑一步；ended = 已终态；lost = 领取被别的副本接手 */
export type StepOutcome = "continue" | "ended" | "lost";

/** 领取被别的副本接手（心跳过期后）：本副本停止对这个 run 的一切写入 */
export class ClaimLostError extends Error {
  constructor(runId: string) {
    super(`agent run ${runId} 的领取已被别的副本接手`);
    this.name = "ClaimLostError";
  }
}

type ToolResult = {
  /** tool_result 的 content（JSON 串，≤ 8KB） */
  content: string;
  summary: string;
  isError: boolean;
  errorCode: ToolErrorCode | null;
};

type RunWithGroup = AgentRun & { group: Group };

// ---- 小工具 ----------------------------------------------------------------------------------

const clipChars = (s: string, max: number): string => {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
};

/** 按字节截断且不切坏多字节字符 */
export function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const bytes = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return new TextDecoder("utf-8").decode(bytes).replace(/�+$/u, "");
}

/** 键排序后的 JSON 串：比较「相同入参」用，不受键顺序影响 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const ok = (value: Record<string, unknown>, summary: string): ToolResult => ({
  content: fitContent(value),
  summary: clipChars(summary, RESULT_SUMMARY_MAX_CHARS),
  isError: false,
  errorCode: null,
});

const fail = (
  code: ToolErrorCode,
  message: string,
  hint?: string,
): ToolResult => ({
  content: fitContent({ code, message, ...(hint ? { hint } : {}) }),
  summary: clipChars(`${code}: ${message}`, RESULT_SUMMARY_MAX_CHARS),
  isError: true,
  errorCode: code,
});

/**
 * A5 第 9 条：content ≤ 8KB，且必须仍是 JSON 串（2.2）。超出：messages 数组从最旧的一端丢，置 truncated: true；
 * 没有数组可丢（例如超长的工具名写进了 UNKNOWN_TOOL 的 message）就把最长的字符串字段对半截，直到放得下 ——
 * code 等短字段原样保留，agent 仍能按 code 决定下一步。按字节硬截会截出半个 JSON。
 */
export function fitContent(value: Record<string, unknown>): string {
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= RESULT_CONTENT_MAX_BYTES) return text;
  const messages: unknown = value.messages;
  if (Array.isArray(messages)) {
    const rest: unknown[] = [...(messages as unknown[])];
    while (rest.length > 0) {
      rest.shift();
      text = JSON.stringify({ ...value, messages: rest, truncated: true });
      if (Buffer.byteLength(text, "utf8") <= RESULT_CONTENT_MAX_BYTES) {
        return text;
      }
    }
  }
  const shrunk: Record<string, unknown> = { ...value, truncated: true };
  for (;;) {
    text = JSON.stringify(shrunk);
    if (Buffer.byteLength(text, "utf8") <= RESULT_CONTENT_MAX_BYTES) {
      return text;
    }
    let longest: string | null = null;
    for (const [key, v] of Object.entries(shrunk)) {
      if (typeof v !== "string") continue;
      const current = longest === null ? -1 : String(shrunk[longest]).length;
      if (v.length > current) longest = key;
    }
    const target = longest === null ? "" : String(shrunk[longest]);
    if (longest === null || target.length <= 1) {
      // 没有可截的字符串（大块结构化数据）：只留截断标记，仍是合法 JSON
      return JSON.stringify({ truncated: true });
    }
    shrunk[longest] = `${target.slice(0, Math.floor(target.length / 2))}…`;
  }
}

function elapsedMs(
  run: Pick<AgentRun, "accumulatedMs" | "activeSince">,
  now: Date,
): number {
  return (
    run.accumulatedMs +
    (run.activeSince
      ? Math.max(0, now.getTime() - run.activeSince.getTime())
      : 0)
  );
}

const asJson = (v: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

function toTriggerMessage(m: {
  msgId: string | null;
  senderPlatformUserId: string;
  text: string;
  sentAt: Date;
}): TriggerMessage {
  return {
    msgId: m.msgId ?? "",
    senderPlatformUserId: m.senderPlatformUserId,
    text: m.text,
    sentAt: m.sentAt.toISOString(),
  };
}

async function emitRunEvent(
  tx: Db,
  run: Pick<AgentRun, "id" | "groupId" | "status" | "endReason">,
): Promise<void> {
  await emitWsEvent(tx, "agent_run", {
    runId: run.id,
    groupId: run.groupId,
    status: run.status,
    endReason: run.endReason,
  });
}

// ---- 触发（A5 第 1 条）----------------------------------------------------------------------------

/**
 * 入站 service 写入一条**非自己**的消息后、同一事务里调（tx 必传：run / pending 与消息一起提交或一起回滚）。
 * agentEnabled 且 active 的群才处理。返回 run_created / pending / ignored。
 */
export async function onInboundMessage(
  input: { groupId: string; messageId: string },
  deps: {
    tx: Tx;
    clock?: Clock;
    log?: AgentLog;
    /** 测试用：并发用例在「查过 running、还没 INSERT」的缝上停住，让另一个事务先提交 */
    checkpoint?: (point: "before_insert") => Promise<void>;
  },
): Promise<TriggerOutcome> {
  const { tx } = deps;
  const clock = deps.clock ?? systemClock;
  const group = await tx.group.findUnique({
    where: { id: input.groupId },
    select: { id: true, status: true, agentEnabled: true },
  });
  if (!group || group.status !== "active") {
    return { kind: "ignored", reason: "group_inactive" };
  }
  if (!group.agentEnabled) return { kind: "ignored", reason: "agent_disabled" };
  const message = await tx.message.findUnique({
    where: { id: input.messageId },
    select: {
      id: true,
      msgId: true,
      senderPlatformUserId: true,
      text: true,
      sentAt: true,
      isOwn: true,
    },
  });
  if (!message) return { kind: "ignored", reason: "no_message" };
  if (message.isOwn) return { kind: "ignored", reason: "own_message" };

  // 至多绕两圈：第一圈没 running 就插；ON CONFLICT 没插进去说明别的事务刚提交了一个，第二圈一定能 FOR SHARE 到它
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const running = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM agent_runs
      WHERE group_id = ${group.id} AND status = 'running'
      FOR SHARE`;
    const current = running[0];
    if (current) {
      await tx.agentPendingMessage.createMany({
        data: { runId: current.id, messageId: message.id },
        skipDuplicates: true,
      });
      deps.log?.info(
        { groupId: group.id, runId: current.id, messageId: message.id },
        "群已有 running 的 agent run，消息记为待处理",
      );
      return { kind: "pending", runId: current.id };
    }
    await deps.checkpoint?.("before_insert");
    const id = randomUUID();
    const now = clock.now();
    const trigger = JSON.stringify([toTriggerMessage(message)]);
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO agent_runs (id, group_id, status, trigger_messages, created_at, updated_at)
      VALUES (${id}, ${group.id}, 'running', ${trigger}::jsonb, ${now}, ${now})
      ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING
      RETURNING id`;
    if (inserted[0]) {
      await emitRunEvent(tx, {
        id,
        groupId: group.id,
        status: "running",
        endReason: null,
      });
      deps.log?.info(
        { groupId: group.id, runId: id, messageId: message.id },
        "已创建 agent run",
      );
      return { kind: "run_created", runId: id };
    }
  }
  throw new Error(`群 ${group.id} 的 agent run 触发反复撞上并发创建，放弃`);
}

// ---- 领取 / 释放（worker 用）-----------------------------------------------------------------------

/**
 * 领一个 running 且没人持有（claimedBy 空 / 心跳过期）的 run：FOR UPDATE SKIP LOCKED，多副本各领各的。
 * 接手心跳过期的 run 时只把「心跳还活着」的那段（heartbeatAt − activeSince）折进 accumulatedMs：
 * 执行者死掉到现在这段没人在跑，不算预算（A5：停机时间不计）。
 */
export async function claimRun(
  workerId: string,
  now: Date,
  opts: {
    staleMs?: number;
    /**
     * 领取者（worker 实例）启动的时刻：第一次被领取的 run 把「创建 → 领取」的排队时间折进预算，但只算这个时刻之后的
     * 部分（之前可能是停机，A5：停机时间不计）。不给 = 从创建时刻起全算。
     */
    workerStartedAt?: Date;
  } = {},
): Promise<string | null> {
  const staleMs = opts.staleMs ?? STALE_HEARTBEAT_MS;
  const staleBefore = new Date(now.getTime() - staleMs);
  return getDb().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        active_since: Date | null;
        heartbeat_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, active_since, heartbeat_at, created_at FROM agent_runs
      WHERE status = 'running'
        AND (claimed_by IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ${staleBefore})
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) return null;
    // 从没被领过（heartbeat_at 空）：排队时间计入预算（60 秒从创建起算），只算领取者启动之后的部分；
    // 接手心跳过期的：只算心跳还活着的那段
    const queuedSince = new Date(
      Math.max(
        row.created_at.getTime(),
        opts.workerStartedAt?.getTime() ?? row.created_at.getTime(),
      ),
    );
    const fold =
      row.heartbeat_at === null
        ? Math.max(0, now.getTime() - queuedSince.getTime())
        : row.active_since
          ? Math.max(0, row.heartbeat_at.getTime() - row.active_since.getTime())
          : 0;
    await tx.agentRun.update({
      where: { id: row.id },
      data: {
        claimedBy: workerId,
        heartbeatAt: now,
        activeSince: now,
        accumulatedMs: { increment: fold },
      },
    });
    return row.id;
  });
}

/** 释放（优雅停机 / 一个 tick 结束）：当前活跃段折进 accumulatedMs、activeSince 置空。run 已终态时 endRun 早清过了，no-op。 */
export async function releaseRun(
  runId: string,
  workerId: string,
  now: Date,
): Promise<void> {
  await getDb().$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.claimedBy !== workerId) return;
    await tx.agentRun.updateMany({
      where: { id: runId, claimedBy: workerId },
      data: {
        claimedBy: null,
        activeSince: null,
        accumulatedMs: elapsedMs(run, now),
      },
    });
  });
}

/** 事务里更新心跳，顺便验证领取仍在本副本手上；不在 → ClaimLostError（调用方停止对这个 run 的写入）。 */
async function touchRun(
  tx: Db,
  runId: string,
  workerId: string,
  now: Date,
): Promise<void> {
  const changed = await tx.agentRun.updateMany({
    where: { id: runId, claimedBy: workerId, status: "running" },
    data: { heartbeatAt: now },
  });
  if (changed.count === 0) throw new ClaimLostError(runId);
}

// ---- 结束 run（+ pending 合并成下一次 run）------------------------------------------------------------

/**
 * running → 终态（status / endReason 对应关系由 CHECK 约束兜底），activeSince 折进 accumulatedMs，释放领取；
 * 写 ws_events agent_run。有 pending 且群仍 agentEnabled + active → 同一事务创建下一次 run，
 * triggerMessages = 全部 pending 按 sentAt 升序（A5 第 1 条「立即创建」）。
 */
async function endRun(
  tx: Tx,
  run: Pick<AgentRun, "id" | "groupId" | "accumulatedMs" | "activeSince">,
  status: Exclude<AgentRunStatus, "running">,
  endReason: AgentRunEndReason,
  now: Date,
  deps: Pick<AgentRunDeps, "workerId" | "log">,
  extra: { summary?: string } = {},
): Promise<{ nextRunId: string | null }> {
  const changed = await tx.agentRun.updateMany({
    where: { id: run.id, status: "running", claimedBy: deps.workerId },
    data: {
      status,
      endReason,
      ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
      finishedAt: now,
      activeSince: null,
      claimedBy: null,
      accumulatedMs: elapsedMs(run, now),
    },
  });
  if (changed.count === 0) throw new ClaimLostError(run.id);
  await emitRunEvent(tx, {
    id: run.id,
    groupId: run.groupId,
    status,
    endReason,
  });

  const pending = await tx.agentPendingMessage.findMany({
    where: { runId: run.id },
    include: {
      message: {
        select: {
          id: true,
          msgId: true,
          senderPlatformUserId: true,
          text: true,
          sentAt: true,
        },
      },
    },
  });
  if (pending.length === 0) return { nextRunId: null };
  const group = await tx.group.findUnique({
    where: { id: run.groupId },
    select: { status: true, agentEnabled: true },
  });
  if (!group || group.status !== "active" || !group.agentEnabled) {
    deps.log?.info(
      { runId: run.id, pending: pending.length },
      "run 结束时有待处理消息，但群已关闭 agent / 不可用，不再触发",
    );
    return { nextRunId: null };
  }
  const messages = pending
    .map((p) => p.message)
    .sort(
      (a, b) =>
        a.sentAt.getTime() - b.sentAt.getTime() || a.id.localeCompare(b.id),
    )
    .map(toTriggerMessage);
  const next = await tx.agentRun.create({
    data: {
      groupId: run.groupId,
      status: "running",
      triggerMessages: asJson(messages),
      createdAt: now,
    },
  });
  await emitRunEvent(tx, next);
  deps.log?.info(
    { runId: run.id, nextRunId: next.id, triggerMessages: messages.length },
    "run 结束，待处理消息已合并成下一次 run",
  );
  return { nextRunId: next.id };
}

/** 外部状态 / 上限（A5 第 2、10 条）：该结束就结束（一个事务），返回 true；否则 false。 */
async function endIfDue(
  run: RunWithGroup,
  deps: AgentRunDeps,
): Promise<boolean> {
  const now = deps.clock.now();
  let verdict: {
    status: Exclude<AgentRunStatus, "running">;
    reason: AgentRunEndReason;
  } | null = null;
  if (run.group.status !== "active" || !run.group.agentEnabled) {
    verdict = { status: "cancelled", reason: "cancelled" };
  } else if (
    run.consecutiveProtocolErrors >= CONSECUTIVE_PROTOCOL_ERRORS_LIMIT
  ) {
    verdict = { status: "failed", reason: "protocol_errors" };
  } else if (run.stepCount >= run.maxSteps) {
    verdict = { status: "failed", reason: "budget_exhausted" };
  } else if (elapsedMs(run, now) >= run.budgetMs) {
    verdict = { status: "failed", reason: "wall_clock" };
  }
  if (!verdict) return false;
  const { status, reason } = verdict;
  await getDb().$transaction((tx) =>
    endRun(tx, run, status, reason, now, deps),
  );
  deps.log?.info(
    { runId: run.id, status, endReason: reason, stepCount: run.stepCount },
    "agent run 结束",
  );
  return true;
}

// ---- 一步 --------------------------------------------------------------------------------------------

async function loadRun(runId: string): Promise<RunWithGroup | null> {
  return getDb().agentRun.findUnique({
    where: { id: runId },
    include: { group: true },
  });
}

/**
 * 跑一步（一次 /agent/turn 往返；有未完成的步就先把它续完，不再调 turn）。worker 反复调它直到返回 ended / lost。
 * 前提：run 已被 deps.workerId 领取（claimRun）。
 */
export async function runStep(
  runId: string,
  deps: AgentRunDeps,
): Promise<StepOutcome> {
  const run = await loadRun(runId);
  if (!run || run.status !== "running") return "ended";
  if (run.claimedBy !== deps.workerId) return "lost";

  try {
    // 未完成的步（上次中断处）先续完再判上限：它可能已经对外产生了效果（消息已入队 / kick 已发），
    // 结果必须落库；上限与外部状态在这一步之后（afterStep）再判
    const inflight = await getDb().agentStep.findFirst({
      where: { runId, completedAt: null },
      orderBy: { index: "desc" },
    });
    if (!inflight && (await endIfDue(run, deps))) return "ended";
    let step: AgentStep;
    if (inflight) {
      deps.log?.warn(
        { runId, stepIndex: inflight.index, name: inflight.name },
        "发现未完成的步（上次中断处），从这里续",
      );
      step = inflight;
    } else {
      const created = await takeTurn(run, deps);
      if (created === "ended") return "ended";
      if (created === "recorded") return afterStep(runId, deps);
      step = created;
    }
    const blocked = await executeTool(run, step, deps);
    if (blocked) return "ended";
    return afterStep(runId, deps);
  } catch (err) {
    if (err instanceof ClaimLostError) {
      deps.log?.warn({ runId }, err.message);
      return "lost";
    }
    throw err;
  }
}

async function afterStep(
  runId: string,
  deps: AgentRunDeps,
): Promise<StepOutcome> {
  const fresh = await loadRun(runId);
  if (!fresh || fresh.status !== "running") return "ended";
  if (fresh.claimedBy !== deps.workerId) return "lost";
  return (await endIfDue(fresh, deps)) ? "ended" : "continue";
}

/**
 * 调一次 /agent/turn 并把结果落库：
 * - 协议错误 → protocol_error 步（已完成）→ "recorded"
 * - end_turn / finish / UNKNOWN_TOOL / INVALID_INPUT → 步已完成（finish / end_turn 同时结束 run）→ "recorded" | "ended"
 * - 需要执行的工具 → 返回未完成的 step 行（toolStartedAt / completedAt 为空）
 */
async function takeTurn(
  run: RunWithGroup,
  deps: AgentRunDeps,
): Promise<AgentStep | "recorded" | "ended"> {
  const db = getDb();
  await touchRun(db, run.id, deps.workerId, deps.clock.now());
  const messages = await buildMessages(run);
  await deps.checkpoint?.("before_turn");
  const result = await deps.agent.turn(
    { runId: run.id, tools: AGENT_TOOLS, messages },
    { timeoutMs: deps.turnTimeoutMs },
  );
  const now = deps.clock.now();
  const raw = clipBytes(result.raw, RAW_RESPONSE_MAX_BYTES);

  if (!result.ok) {
    await recordProtocolError(run, result.code, result.reason, raw, now, deps);
    return "recorded";
  }
  if (result.turn.stop_reason === "end_turn") {
    const text = result.turn.text;
    await db.$transaction(async (tx) => {
      await touchRun(tx, run.id, deps.workerId, now);
      await tx.agentStep.create({
        data: {
          runId: run.id,
          index: run.stepCount + 1,
          kind: "final",
          resultSummary: clipChars(text, RESULT_SUMMARY_MAX_CHARS),
          rawResponse: raw,
          completedAt: now,
        },
      });
      await tx.agentRun.update({
        where: { id: run.id },
        data: { stepCount: { increment: 1 }, consecutiveProtocolErrors: 0 },
      });
      await endRun(tx, run, "finished", "final", now, deps, { summary: text });
    });
    deps.log?.info(
      { runId: run.id, stepIndex: run.stepCount + 1 },
      "end_turn，run finished",
    );
    return "ended";
  }

  const block = result.turn.block;
  const duplicate = await db.agentStep.findFirst({
    where: { runId: run.id, toolUseId: block.id },
    select: { index: true },
  });
  if (duplicate) {
    await recordProtocolError(
      run,
      "DUPLICATE_TOOL_USE_ID",
      `tool_use.id ${block.id} 已在第 ${duplicate.index} 步用过，每次调用要用新的 id`,
      raw,
      now,
      deps,
    );
    return "recorded";
  }

  const validation = validateToolCall(block);
  if (!validation.ok) {
    await createToolStep(run, block, raw, now, deps, {
      protocolError: true,
      immediate: fail(validation.code, validation.message, validation.hint),
    });
    return "recorded";
  }
  if (validation.name === "finish") {
    const summary = validation.input.summary;
    await createToolStep(run, block, raw, now, deps, {
      kind: "final",
      immediate: ok({ ok: true }, summary),
      finish: summary,
    });
    deps.log?.info(
      { runId: run.id, stepIndex: run.stepCount + 1 },
      "finish，run finished",
    );
    return "ended";
  }
  const step = await createToolStep(run, block, raw, now, deps, {});
  await deps.checkpoint?.("after_turn_persisted");
  return step;
}

type ToolValidation =
  | { ok: true; name: "get_recent_messages"; input: { limit: number } }
  | {
      ok: true;
      name: "send_message";
      input: { text: string; idempotency_key: string };
    }
  | {
      ok: true;
      name: "kick_user";
      input: { platform_user_id: string; reason: string };
    }
  | { ok: true; name: "finish"; input: { summary: string } }
  | {
      ok: false;
      code: "UNKNOWN_TOOL" | "INVALID_INPUT";
      message: string;
      hint?: string;
    };

export function validateToolCall(block: ToolUseBlock): ToolValidation {
  if (!(block.name in TOOL_INPUT_SCHEMAS)) {
    return {
      ok: false,
      code: "UNKNOWN_TOOL",
      message: `没有名为 ${block.name} 的工具`,
      hint: `可用工具：${Object.keys(TOOL_INPUT_SCHEMAS).join(" / ")}`,
    };
  }
  const name = block.name as ToolName;
  const parsed = TOOL_INPUT_SCHEMAS[name].safeParse(block.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `${name} 的入参不符合 input_schema：${issues}`,
      hint: "按 tools 里的 input_schema 重新组织入参",
    };
  }
  return { ok: true, name, input: parsed.data } as ToolValidation;
}

/** 协议错误步（不追加 assistant 块）：consecutiveProtocolErrors + 1，达上限则同事务结束 run（A5 第 2、3 条）。 */
async function recordProtocolError(
  run: RunWithGroup,
  code: "BAD_JSON" | "DUPLICATE_TOOL_USE_ID" | "TURN_TIMEOUT",
  reason: string,
  raw: string,
  now: Date,
  deps: AgentRunDeps,
): Promise<void> {
  const consecutive = run.consecutiveProtocolErrors + 1;
  await getDb().$transaction(async (tx) => {
    await touchRun(tx, run.id, deps.workerId, now);
    await tx.agentStep.create({
      data: {
        runId: run.id,
        index: run.stepCount + 1,
        kind: "protocol_error",
        isError: true,
        errorCode: code,
        resultContent: `PROTOCOL_ERROR ${code}: ${reason}`,
        resultSummary: clipChars(
          `${code}: ${reason}`,
          RESULT_SUMMARY_MAX_CHARS,
        ),
        rawResponse: raw,
        completedAt: now,
      },
    });
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        stepCount: { increment: 1 },
        consecutiveProtocolErrors: consecutive,
      },
    });
    if (consecutive >= CONSECUTIVE_PROTOCOL_ERRORS_LIMIT) {
      await endRun(tx, run, "failed", "protocol_errors", now, deps);
    }
  });
  deps.log?.warn(
    { runId: run.id, stepIndex: run.stepCount + 1, code, reason, consecutive },
    consecutive >= CONSECUTIVE_PROTOCOL_ERRORS_LIMIT
      ? "连续协议错误达上限，run failed"
      : "协议错误",
  );
}

/**
 * tool_use 步（正常追加 assistant 块）：先落库再执行。immediate 给了就是不需要执行的（UNKNOWN_TOOL / INVALID_INPUT /
 * finish），直接完成；finish 同事务结束 run。UNKNOWN_TOOL / INVALID_INPUT（protocolError）让
 * consecutiveProtocolErrors + 1，达上限同事务结束 run；合法响应清零。
 */
async function createToolStep(
  run: RunWithGroup,
  block: ToolUseBlock,
  raw: string,
  now: Date,
  deps: AgentRunDeps,
  opts: {
    kind?: "tool_use" | "final";
    immediate?: ToolResult;
    finish?: string;
    protocolError?: boolean;
  },
): Promise<AgentStep> {
  const consecutive = opts.protocolError
    ? run.consecutiveProtocolErrors + 1
    : 0;
  return getDb().$transaction(async (tx) => {
    await touchRun(tx, run.id, deps.workerId, now);
    const step = await tx.agentStep.create({
      data: {
        runId: run.id,
        index: run.stepCount + 1,
        kind: opts.kind ?? "tool_use",
        toolUseId: block.id,
        name: block.name,
        input: asJson(block.input),
        rawResponse: raw,
        ...(opts.immediate
          ? {
              resultContent: opts.immediate.content,
              resultSummary: opts.immediate.summary,
              isError: opts.immediate.isError,
              errorCode: opts.immediate.errorCode,
              completedAt: now,
            }
          : {}),
      },
    });
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        stepCount: { increment: 1 },
        consecutiveProtocolErrors: consecutive,
      },
    });
    if (consecutive >= CONSECUTIVE_PROTOCOL_ERRORS_LIMIT) {
      await endRun(tx, run, "failed", "protocol_errors", now, deps);
    }
    if (opts.finish !== undefined) {
      await endRun(tx, run, "finished", "final", now, deps, {
        summary: opts.finish,
      });
    }
    return step;
  });
}

/** 工具执行完写结果（同事务刷心跳 + 验证领取） */
async function completeStep(
  runId: string,
  stepId: string,
  result: ToolResult,
  deps: AgentRunDeps,
): Promise<void> {
  const now = deps.clock.now();
  await getDb().$transaction(async (tx) => {
    await touchRun(tx, runId, deps.workerId, now);
    await tx.agentStep.update({
      where: { id: stepId },
      data: {
        resultContent: result.content,
        resultSummary: result.summary,
        isError: result.isError,
        errorCode: result.errorCode,
        completedAt: now,
      },
    });
  });
}

// ---- 历史重建（发给 /agent/turn 的 messages）----------------------------------------------------------

/**
 * messages[0] = 触发上下文 JSON（题目 2.2）；之后按 agent_steps 重建：tool_use 步 → assistant tool_use 块 +
 * user tool_result 块（is_error 时带上）；protocol_error 步 → user text `PROTOCOL_ERROR <code>: <一句话>`。
 * ownPlatformUserIds 每轮现算（群成员里的服务账号）。
 */
export async function buildMessages(
  run: RunWithGroup,
): Promise<AgentMessage[]> {
  const db = getDb();
  const own = await db.groupMember.findMany({
    where: { groupId: run.groupId, accountId: { not: null } },
    select: { platformUserId: true },
    orderBy: { platformUserId: "asc" },
  });
  const context = {
    groupId: run.group.gatewayGroupId ?? run.group.id,
    triggerMessages: run.triggerMessages as unknown as TriggerMessage[],
    policy: { autoKickEnabled: run.group.autoKickEnabled },
    ownPlatformUserIds: own.map((m) => m.platformUserId),
  };
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: JSON.stringify(context) }],
    },
  ];
  const steps = await db.agentStep.findMany({
    where: { runId: run.id },
    orderBy: { index: "asc" },
  });
  for (const step of steps) {
    if (step.kind === "protocol_error") {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              step.resultContent ??
              `PROTOCOL_ERROR ${step.errorCode ?? "BAD_JSON"}: 上一轮响应不合法`,
          },
        ],
      });
      continue;
    }
    if (step.toolUseId === null || step.name === null) continue;
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: step.toolUseId,
          name: step.name,
          input: (step.input ?? {}) as Record<string, unknown>,
        },
      ],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: step.toolUseId,
          content: step.resultContent ?? "",
          ...(step.isError ? { is_error: true } : {}),
        },
      ],
    });
  }
  return messages;
}

// ---- 工具执行 --------------------------------------------------------------------------------------------

/** 返回 true = run 已 blocked（审计拿不到结论），调用方结束这一步 */
async function executeTool(
  run: RunWithGroup,
  step: AgentStep,
  deps: AgentRunDeps,
): Promise<boolean> {
  switch (step.name) {
    case "get_recent_messages": {
      const result = await recentMessages(run, step);
      await completeStep(run.id, step.id, result, deps);
      return false;
    }
    case "send_message":
      return executeSend(run, step, deps);
    case "kick_user":
      return executeKick(run, step, deps);
    default:
      // createToolStep 只会给这三种留下未完成的步；到这里是数据被人改过
      await completeStep(
        run.id,
        step.id,
        fail("UNKNOWN_TOOL", `没有名为 ${step.name ?? "?"} 的工具`),
        deps,
      );
      return false;
  }
}

/** get_recent_messages（题目 2.2 工具表 + A5 第 11 条） */
async function recentMessages(
  run: RunWithGroup,
  step: AgentStep,
): Promise<ToolResult> {
  const db = getDb();
  const input = step.input as { limit: number };
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit)),
    RECENT_MESSAGES_MAX,
  );
  const rows = await db.message.findMany({
    where: { groupId: run.groupId },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  rows.reverse();
  let truncated = false;
  const messages = rows.map((r) => {
    let text = r.text;
    if (Array.from(text).length > RECENT_TEXT_MAX_CHARS) {
      text = clipChars(text, RECENT_TEXT_MAX_CHARS);
      truncated = true;
    }
    return {
      msgId: r.msgId,
      senderPlatformUserId: r.senderPlatformUserId,
      isOwn: r.isOwn,
      text,
      sentAt: r.sentAt.toISOString(),
    };
  });

  // 连续相同入参：看紧挨着的前 (REPEATED_CALL_HINT_FROM − 1) 步是否都是同名同入参的 tool_use
  const previous = await db.agentStep.findMany({
    where: { runId: run.id, index: { lt: step.index } },
    orderBy: { index: "desc" },
    take: REPEATED_CALL_HINT_FROM - 1,
  });
  const mine = canonicalJson(step.input);
  const repeated =
    previous.length === REPEATED_CALL_HINT_FROM - 1 &&
    previous.every(
      (p) =>
        p.kind === "tool_use" &&
        p.name === "get_recent_messages" &&
        canonicalJson(p.input) === mine,
    );
  const value: Record<string, unknown> = { messages, truncated };
  if (repeated) {
    value.hint =
      `已连续 ${REPEATED_CALL_HINT_FROM} 次以相同入参调用 get_recent_messages，再调结果不会变；` +
      "请基于已有消息决定 send_message 或 finish";
  }
  return ok(
    value,
    `返回 ${messages.length} 条消息${truncated ? "（有截断）" : ""}${repeated ? "；重复调用已提示" : ""}`,
  );
}

/**
 * 审计（A5 第 4 条）。auditAttempts 先写后调（进程死在中间那次算用掉）；pass / fail 落 auditVerdict。
 * 返回 blocked 时 run 已 blocked（audit_blocked）、这一步已按「未执行」收口。
 */
async function runAudit(
  run: RunWithGroup,
  step: AgentStep,
  text: string,
  deps: AgentRunDeps,
): Promise<"pass" | "fail" | "blocked"> {
  const db = getDb();
  let attempts = step.auditAttempts;
  while (attempts < AUDIT_MAX_ATTEMPTS) {
    attempts += 1;
    await db.$transaction(async (tx) => {
      await touchRun(tx, run.id, deps.workerId, deps.clock.now());
      await tx.agentStep.update({
        where: { id: step.id },
        data: { auditAttempts: attempts },
      });
    });
    const r = await deps.agent.audit(
      { text, groupId: run.group.gatewayGroupId ?? run.group.id },
      { timeoutMs: deps.auditTimeoutMs },
    );
    if (r.verdict === "pass" || r.verdict === "fail") {
      await db.agentStep.update({
        where: { id: step.id },
        data: { auditVerdict: r.verdict },
      });
      deps.log?.info(
        { runId: run.id, stepIndex: step.index, verdict: r.verdict, attempts },
        "审计结论",
      );
      return r.verdict;
    }
    deps.log?.warn(
      {
        runId: run.id,
        stepIndex: step.index,
        attempts,
        reason: r.reason,
        status: r.status,
      },
      "审计没拿到结论",
    );
  }
  const now = deps.clock.now();
  await db.$transaction(async (tx) => {
    await touchRun(tx, run.id, deps.workerId, now);
    await tx.agentStep.update({
      where: { id: step.id },
      data: {
        resultSummary: `审计 ${AUDIT_MAX_ATTEMPTS} 次都没拿到结论，run 已 blocked，工具未执行`,
        completedAt: now,
      },
    });
    await endRun(tx, run, "blocked", "audit_blocked", now, deps);
  });
  deps.log?.warn(
    { runId: run.id, stepIndex: step.index },
    "审计拿不到结论，run blocked",
  );
  return "blocked";
}

/** online 的群成员账号（accountId 最小者优先）；forKick 时只要 creator / admin，群主优先 */
async function pickAccount(
  groupId: string,
  forKick: boolean,
): Promise<{ id: string } | null> {
  const rows = await getDb().groupMember.findMany({
    where: {
      groupId,
      accountId: { not: null },
      account: { status: "online" },
      ...(forKick ? { role: { in: ["creator", "admin"] } } : {}),
    },
    select: { accountId: true, role: true },
    orderBy: [{ role: "asc" }, { accountId: "asc" }],
  });
  const first = rows[0];
  return first?.accountId ? { id: first.accountId } : null;
}

/** 出站行的终态 → 工具错误（题目 2.2 工具表：群不可写 → GROUP_UNREACHABLE；账号停用 / 失效 / 中途终态 → SEND_FAILED） */
function deliveryFailure(
  status: string,
  failCode: string | null,
  clientMsgId: string,
): ToolResult {
  if (
    failCode === "GROUP_WRITE_FORBIDDEN" ||
    failCode === "GROUP_UNREACHABLE"
  ) {
    return fail(
      "GROUP_UNREACHABLE",
      `群不可写（${failCode}），消息 ${clientMsgId} 未发出`,
    );
  }
  return fail(
    "SEND_FAILED",
    `消息 ${clientMsgId} ${status === "cancelled" ? "已取消" : "发送失败"}（${failCode ?? "未知原因"}）`,
  );
}

/** send_message（题目 2.2 工具表 + A5 第 5、7、8 条 + S5）。返回 true = run 已 blocked。 */
async function executeSend(
  run: RunWithGroup,
  step: AgentStep,
  deps: AgentRunDeps,
): Promise<boolean> {
  const db = getDb();
  const input = step.input as { text: string; idempotency_key: string };
  const key = input.idempotency_key;

  // 幂等（A5 第 7 条）：同 run 同 key 已入过队 → 不发、不审，返回那条消息的当前状态。
  // toolStartedAt 非空说明入队的就是本步（上次死在入队与记结果之间，A5 第 8 条）→ 照常等结果。
  const hit = await db.agentIdempotency.findUnique({
    where: { runId_key: { runId: run.id, key } },
  });
  if (hit && step.toolStartedAt === null) {
    const msg = await db.message.findUnique({
      where: { clientMsgId: hit.clientMsgId },
    });
    const status = msg?.deliveryStatus ?? null;
    const result =
      !msg || status === null
        ? fail("SEND_FAILED", `消息 ${hit.clientMsgId} 已不存在`)
        : status === "failed" || status === "cancelled"
          ? deliveryFailure(status, msg.failCode, hit.clientMsgId)
          : ok(
              { clientMsgId: hit.clientMsgId, deliveryStatus: status },
              `幂等命中 ${key}：${hit.clientMsgId} 当前 ${status}`,
            );
    await completeStep(run.id, step.id, result, deps);
    deps.log?.info(
      {
        runId: run.id,
        stepIndex: step.index,
        key,
        clientMsgId: hit.clientMsgId,
        status,
      },
      "send_message 幂等命中，不再发送 / 审计",
    );
    return false;
  }

  let clientMsgId: string;
  if (hit) {
    clientMsgId = hit.clientMsgId;
  } else {
    if (step.auditVerdict !== "pass") {
      const verdict = await runAudit(run, step, input.text, deps);
      if (verdict === "blocked") return true;
      if (verdict === "fail") {
        await completeStep(
          run.id,
          step.id,
          fail(
            "AUDIT_REJECTED",
            "审计未通过，消息未发送",
            "换一种说法或放弃发送",
          ),
          deps,
        );
        return false;
      }
    }
    await deps.checkpoint?.("after_audit");

    const account = await pickAccount(run.groupId, false);
    if (!account) {
      await completeStep(
        run.id,
        step.id,
        fail("NO_AVAILABLE_ACCOUNT", "群里没有在线的服务账号可以发消息"),
        deps,
      );
      return false;
    }

    // 入队 + 幂等记录 + toolStartedAt 一个事务：要么都在，要么都不在（写库先于副作用）
    const now = deps.clock.now();
    try {
      clientMsgId = await db.$transaction(async (tx) => {
        await touchRun(tx, run.id, deps.workerId, now);
        const r = await enqueueMessageInTx(
          tx,
          {
            groupId: run.groupId,
            accountId: account.id,
            text: input.text,
            source: "agent",
          },
          { clock: deps.clock },
        );
        await tx.agentIdempotency.create({
          data: { runId: run.id, key, clientMsgId: r.clientMsgId },
        });
        await tx.agentStep.update({
          where: { id: step.id },
          data: { toolStartedAt: now },
        });
        return r.clientMsgId;
      });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const result =
        err.code === "GROUP_UNREACHABLE" || err.code === "GROUP_NOT_FOUND"
          ? fail("GROUP_UNREACHABLE", err.message)
          : err.code === "ACCOUNT_NOT_IN_GROUP"
            ? fail("NO_AVAILABLE_ACCOUNT", err.message)
            : fail(
                "SEND_FAILED",
                `账号 ${account.id} 在执行中途不可用：${err.message}`,
              );
      await completeStep(run.id, step.id, result, deps);
      return false;
    }
    deps.log?.info(
      {
        runId: run.id,
        stepIndex: step.index,
        key,
        clientMsgId,
        accountId: account.id,
      },
      "agent 消息已入队",
    );
    await deps.checkpoint?.("after_enqueue");
  }

  const result = await waitForDelivery(clientMsgId, deps);
  await completeStep(run.id, step.id, result, deps);
  return false;
}

/** 等出站行变 accepted / sent（最多 5 秒，按注入的 Clock 算）；failed / cancelled → 错误；到点仍未确认 → SEND_TIMEOUT。 */
async function waitForDelivery(
  clientMsgId: string,
  deps: AgentRunDeps,
): Promise<ToolResult> {
  const start = deps.clock.now().getTime();
  for (;;) {
    const msg = await getDb().message.findUnique({ where: { clientMsgId } });
    const status = msg?.deliveryStatus ?? null;
    if (!msg || status === null) {
      return fail("SEND_FAILED", `消息 ${clientMsgId} 已不存在`);
    }
    if (status === "accepted" || status === "sent") {
      return ok(
        { clientMsgId, deliveryStatus: status },
        `已发送 ${clientMsgId}（${status}）`,
      );
    }
    if (status === "failed" || status === "cancelled") {
      return deliveryFailure(status, msg.failCode, clientMsgId);
    }
    if (deps.clock.now().getTime() - start >= SEND_WAIT_MS) {
      return fail(
        "SEND_TIMEOUT",
        `${SEND_WAIT_MS / 1000} 秒内未能确认消息 ${clientMsgId} 是否发出（当前 ${status}）`,
        "消息仍在投递中；用同一个 idempotency_key 再调一次可查它的当前状态，不会重复发送",
      );
    }
    await deps.sleep(SEND_POLL_MS);
  }
}

/** 在 2 秒内轮询网关成员列表，目标不在了返回 true（题目 2.1：kick 504 后网关保证 2 秒内收敛） */
async function waitUntilRemoved(
  gatewayGroupId: string,
  platformUserId: string,
  deps: AgentRunDeps,
): Promise<boolean> {
  const start = deps.clock.now().getTime();
  for (;;) {
    try {
      const members = await deps.gateway.listMembers(gatewayGroupId);
      if (!members.some((m) => m.platformUserId === platformUserId))
        return true;
    } catch (err) {
      deps.log?.warn({ gatewayGroupId, err }, "成员列表暂时查不到，继续等收敛");
    }
    if (deps.clock.now().getTime() - start >= KICK_CONVERGE_MS) return false;
    await deps.sleep(KICK_POLL_MS);
  }
}

/** kick_user（题目 2.1 kick + 2.2 工具表 + A2 错误表 OWNER_LEFT / NO_PERMISSION + A5 第 5、6、8 条）。返回 true = run 已 blocked。 */
async function executeKick(
  run: RunWithGroup,
  step: AgentStep,
  deps: AgentRunDeps,
): Promise<boolean> {
  const db = getDb();
  const input = step.input as { platform_user_id: string; reason: string };
  const target = input.platform_user_id;
  const finish = async (result: ToolResult): Promise<boolean> => {
    await completeStep(run.id, step.id, result, deps);
    return false;
  };

  const group = await db.group.findUniqueOrThrow({
    where: { id: run.groupId },
  });
  if (!group.autoKickEnabled) {
    return finish(
      fail("POLICY_DENIED", "该群未开启 autoKickEnabled，不允许自动移除成员"),
    );
  }
  if (group.gatewayGroupId === null || group.status !== "active") {
    return finish(fail("GROUP_UNREACHABLE", "群不可用，无法移除成员"));
  }
  const account = await pickAccount(run.groupId, true);
  if (!account) {
    return finish(
      fail(
        "NO_AVAILABLE_ACCOUNT",
        "群里没有在线的群主 / 管理员账号可以执行移除",
      ),
    );
  }
  if (step.auditVerdict !== "pass") {
    const verdict = await runAudit(
      run,
      step,
      JSON.stringify({
        action: "kick",
        platform_user_id: target,
        reason: input.reason,
      }),
      deps,
    );
    if (verdict === "blocked") return true;
    if (verdict === "fail") {
      return finish(fail("AUDIT_REJECTED", "审计未通过，未移除成员"));
    }
  }
  await deps.checkpoint?.("after_audit");

  if (step.toolStartedAt !== null) {
    // 上次死在「发 kick」与「记结果」之间：先看网关，目标已不在就是做过了，不能再做一次（A5 第 8 条）
    deps.log?.warn(
      { runId: run.id, stepIndex: step.index, target },
      "kick 结果未知，先核对成员列表",
    );
    if (await waitUntilRemoved(group.gatewayGroupId, target, deps)) {
      return finish(ok({ kicked: true }, `已移除 ${target}（按成员列表确认）`));
    }
  } else {
    await db.$transaction(async (tx) => {
      await touchRun(tx, run.id, deps.workerId, deps.clock.now());
      await tx.agentStep.update({
        where: { id: step.id },
        data: { toolStartedAt: deps.clock.now() },
      });
    });
  }
  await deps.checkpoint?.("before_kick");

  try {
    await deps.gateway.kick(group.gatewayGroupId, {
      byAccountId: account.id,
      targetPlatformUserId: target,
    });
  } catch (err) {
    if (err instanceof GatewayResponseError) {
      if (err.code === "OWNER_LEFT") {
        return finish(fail("OWNER_LEFT", "群主已退群，网关拒绝移除成员"));
      }
      if (err.code === "NO_PERMISSION") {
        return finish(
          fail(
            "NO_PERMISSION",
            `账号 ${account.id} 在网关侧没有移除成员的权限`,
          ),
        );
      }
      if (err.status === 504 || err.code === "NETWORK_TIMEOUT") {
        if (await waitUntilRemoved(group.gatewayGroupId, target, deps)) {
          return finish(
            ok(
              { kicked: true },
              `已移除 ${target}（网关超时，按成员列表确认）`,
            ),
          );
        }
        return finish(
          fail(
            "GROUP_UNREACHABLE",
            `网关超时，且 ${KICK_CONVERGE_MS / 1000} 秒内成员列表仍包含 ${target}，判定未移除`,
            "可以再试一次 kick_user",
          ),
        );
      }
      if (err.code === "ACCOUNT_OFFLINE") {
        return finish(
          fail("NO_AVAILABLE_ACCOUNT", `执行账号 ${account.id} 在网关侧已离线`),
        );
      }
      return finish(fail("GROUP_UNREACHABLE", `网关拒绝移除：${err.code}`));
    }
    if (err instanceof GatewayUnreachableError) {
      return finish(
        fail("GROUP_UNREACHABLE", "网关不可用，无法移除成员", "稍后再试"),
      );
    }
    throw err;
  }
  deps.log?.info(
    { runId: run.id, stepIndex: step.index, target, accountId: account.id },
    "已移除成员",
  );
  return finish(ok({ kicked: true }, `已移除 ${target}`));
}

// ---- 查询（#13：GET /api/agent-runs/:id、GET /api/groups/:id/agent-runs）------------------------------------

export type AgentStepRead = {
  index: number;
  kind: AgentStep["kind"];
  toolUseId: string | null;
  name: string | null;
  input: Record<string, unknown> | null;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: AgentStep["auditVerdict"];
  auditAttempts: number;
  rawResponse: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type AgentRunRead = {
  id: string;
  groupId: string;
  status: AgentRunStatus;
  endReason: AgentRunEndReason | null;
  summary: string | null;
  stepCount: number;
  maxSteps: number;
  budgetMs: number;
  /** 已计入预算的毫秒数（running 时不含当前活跃段） */
  accumulatedMs: number;
  triggerMessages: TriggerMessage[];
  createdAt: string;
  finishedAt: string | null;
};

export type AgentRunDetail = AgentRunRead & { steps: AgentStepRead[] };

export const AGENT_RUN_LIST_LIMIT = 20;

export function toAgentRunRead(run: AgentRun): AgentRunRead {
  return {
    id: run.id,
    groupId: run.groupId,
    status: run.status,
    endReason: run.endReason,
    summary: run.summary,
    stepCount: run.stepCount,
    maxSteps: run.maxSteps,
    budgetMs: run.budgetMs,
    accumulatedMs: run.accumulatedMs,
    triggerMessages: run.triggerMessages as unknown as TriggerMessage[],
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export function toAgentStepRead(step: AgentStep): AgentStepRead {
  const input =
    typeof step.input === "object" &&
    step.input !== null &&
    !Array.isArray(step.input)
      ? (step.input as Record<string, unknown>)
      : null;
  return {
    index: step.index,
    kind: step.kind,
    toolUseId: step.toolUseId,
    name: step.name,
    input,
    resultSummary: step.resultSummary,
    isError: step.isError,
    errorCode: step.errorCode,
    auditVerdict: step.auditVerdict,
    auditAttempts: step.auditAttempts,
    rawResponse: step.rawResponse,
    createdAt: step.createdAt.toISOString(),
    completedAt: step.completedAt?.toISOString() ?? null,
  };
}

export async function getAgentRun(id: string): Promise<AgentRunDetail> {
  const run = await getDb().agentRun.findUnique({
    where: { id },
    include: { steps: { orderBy: { index: "asc" } } },
  });
  if (!run) {
    throw new NotFound("AGENT_RUN_NOT_FOUND", "agent run 不存在", {
      runId: id,
    });
  }
  return { ...toAgentRunRead(run), steps: run.steps.map(toAgentStepRead) };
}

/** 某群最近的 run（不含 steps）：{ items, total }，items 最多 AGENT_RUN_LIST_LIMIT 条、最新在前；total 是该群全部 run 数 */
export async function listAgentRuns(
  groupId: string,
): Promise<{ items: AgentRunRead[]; total: number }> {
  const db = getDb();
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: { id: true },
  });
  if (!group) {
    throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除", { groupId });
  }
  const [rows, total] = await Promise.all([
    db.agentRun.findMany({
      where: { groupId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AGENT_RUN_LIST_LIMIT,
    }),
    db.agentRun.count({ where: { groupId } }),
  ]);
  return { items: rows.map(toAgentRunRead), total };
}

// ---- 全局列表（#22：GET /api/agent-runs，控制台「Agent 运行」页）-------------------------------------------

export type ListAllAgentRunsOptions = {
  status?: AgentRunStatus;
  groupId?: string;
  /** 上一页的 nextCursor；不给 = 从最新一条开始 */
  before?: string;
  limit?: number;
};

/**
 * 全部群的 run（不含 steps / triggerMessages），可按 status、groupId 筛；keyset 游标分页 `{ items, nextCursor }`：
 * 排序键 (createdAt desc, id desc)，游标见 src/services/cursor.ts（createdAt 由 Clock 写入，毫秒精度）。
 * 翻页途中新建的 run 的 createdAt 比游标新，只会出现在第一页之前，不挤动后面的页 —— 不重不漏。
 * groupId 是筛选条件而不是路径资源：不存在的群返回空列表，不 404。
 */
export async function listAllAgentRuns(
  opts: ListAllAgentRunsOptions = {},
): Promise<AgentRunPage> {
  const limit = clampLimit(opts.limit);
  const cursor =
    opts.before === undefined ? null : decodeTimeCursor(opts.before);
  const where: Prisma.AgentRunWhereInput = {
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
    ...(cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.at } },
            { createdAt: cursor.at, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = await getDb().agentRun.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { group: { select: { gatewayGroupId: true } } },
  });
  const { page, nextCursor } = sliceCursorPage(rows, limit, (last) =>
    encodeTimeCursor({ at: last.createdAt, id: last.id }),
  );
  const items: AgentRunListItem[] = page.map((run) => ({
    id: run.id,
    groupId: run.groupId,
    gatewayGroupId: run.group.gatewayGroupId,
    status: run.status,
    endReason: run.endReason,
    summary: run.summary,
    stepCount: run.stepCount,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
  return { items, nextCursor };
}
