// 定时序列（题目 B1 + 2.3 `POST /api/sequences`、`POST /api/groups/:id/sequence-runs`、`GET /api/sequence-runs/:id`、
// WS `sequence_run`、S7 / S8；issue #15）。
//
// 一切从「进程随时会死、副本不止一个」出发：运行的全部状态在 sequence_runs / sequence_run_steps 里，
// 排期本身是 sequence_run_steps.scheduledAt，worker（src/workers/sequence-worker.ts）的定时器只负责「到点了没」。
//
// 取值链（resolveVars，纯函数）：开始取值 = vars（"" 视为未提供）；第 k 步在 stepVars[k] 里给了非空值 → 从该步起
// 后续都用新值，直到更晚的步再给；stepVars 里的 "" 表示这一步不改。每步输出 resolvedVars（只含该步文本里出现的 key）
// 与 varSources（default | step:<index>，沿用时标最初给出它的那一步）。预检：任一 {key} 解析不到 →
// Invalid UNRESOLVED_PLACEHOLDER { stepIndex, key }，在 INSERT 之前抛 —— 一条不发、不留任何记录。
//
// 启动（startRun）：群存在且 active → 序列存在 → 预检 → 一个事务里 INSERT sequence_runs（running）+ 全部步骤
// （pending，取值快照；第 1 步 scheduledAt = now + delay1，其余为 null）+ ws_events sequence_run。同群至多一个 running
// 靠部分唯一索引 sequence_runs_one_running_per_group（20260930101643_domain_model）：INSERT … ON CONFLICT DO NOTHING，
// 没插进去 → 409 SEQUENCE_ALREADY_RUNNING（并发两次恰好一个 201：后到的事务在 ON CONFLICT 上等先到的提交再判定）。
//
// 推进（advanceRunInTx，worker tick 在 FOR UPDATE SKIP LOCKED 锁住 run 行的事务里调，幂等）：
// - 当前步已结（sent / skipped / failed）而 run 还没推进（账号终态级联在 account-service 里把步改 skipped 时不推进）：
//   排下一步 scheduledAt = 结时刻 + delay，或最后一步 → run finished；
// - 当前步 pending 且到点：选账号（admin = role ∈ {creator, admin} 且 online，优先 admin；member = role = member 且
//   online 按 accountId 字典序）；没有 online 但有 rate_limited 的 → 顺延到限流结束（不跳过）；一个都没有 → skipped
//   （skippedAt = now，视为此刻「发出」，下一步据此排期）；有账号 → 出站入队（outbox，source = sequence）→ 步骤 accepted
//   + clientMsgId，同一事务。
// - 「发出」= 收到 message_sent：outbox-service 的 settle 在消息进终局（sent / failed / cancelled）时调 onOutboundSettled，
//   同一事务里把步骤改 sent / failed，并排下一步。基准都是**此刻**（收到 message_sent / 确认落地的时刻，步骤的 sentAt
//   也记它）：B1「发出」指收到 message_sent 的时刻，不是网关报的 sentAt —— 两边时钟有偏差、事件晚到时后者会让排期整体偏移。
// - 群 unreachable → run stopped 由 group-service.markGroupUnreachable 做（同事务写 ws_events）；推进时发现群已不是
//   active（例如 leave-all 后 left）→ run failed。
//
// 重启后只重排最早一个已过期的步骤（rescheduleStaleStep）：worker 实例启动时刻 workerStartedAt 之前就已到点、
// 仍 pending 的当前步 = 停机期间过期的那一步，改为 now + 该步 delaySeconds；后续步骤仍按「前一步发出后」排，
// 不会一次性全发。判定只看库里的 scheduledAt 与 workerStartedAt，重排后 scheduledAt > workerStartedAt，天然只做一次。
//
// 手写 SQL 用的是数据库列名（@map 的值）；`${}` 是绑定参数。
import { randomUUID } from "node:crypto";

import { type Clock, systemClock } from "../core/clock.js";
import {
  Conflict,
  DomainError,
  Invalid,
  NotFound,
  type ErrorCode,
} from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type {
  Message,
  Prisma,
  SequenceRun,
  SequenceRunStep,
} from "../db/generated/client.js";
import {
  type SequenceDefinition,
  type SequenceList,
  type SequenceRunRead,
  type SequenceRunStepRead,
  SequenceStepDefinition,
  type StartSequenceRunRequest,
  VarMap,
  VarSourceMap,
} from "../schemas/sequence.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 常量 ------------------------------------------------------------------------------

/** 一次 tick 最多推进的 run 数 */
export const DEFAULT_BATCH_SIZE = 20;
/** 限流账号的 rateLimitedUntil 已过但还没被恢复 worker 转回 online：这么久之后再看一次 */
export const RATE_LIMIT_RECHECK_MS = 1_000;
/** 没有匹配账号时 skipped 的 failCode */
export const NO_ACCOUNT_FAIL_CODE = "NO_ACCOUNT";
/** 文本里的占位符：`{key}`，key 匹配 [A-Za-z0-9_]+ */
export const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

// ---- 类型 ------------------------------------------------------------------------------

export type SequenceServiceDeps = {
  clock?: Clock;
  /** 路由传 request.log；worker 传 logger.child({ workerId }) */
  log?: Pick<Logger, "info" | "warn" | "error">;
};

/**
 * 出站入队（outbox-service.enqueueMessageInTx 的形状）。由 worker 注入而不是这里 import：
 * outbox-service 要 import 本文件的 onOutboundSettled（消息终局推进序列），反向 import 会成环。
 */
export type SequenceEnqueue = (
  tx: Prisma.TransactionClient,
  input: {
    groupId: string;
    accountId: string;
    text: string;
    source: "sequence";
  },
  deps: { clock?: Clock },
) => Promise<{ clientMsgId: string; messageId: string }>;

export type SequenceAdvanceDeps = SequenceServiceDeps & {
  enqueue: SequenceEnqueue;
  /**
   * 本 worker 实例的启动时刻：在它之前就已到点、仍 pending 的当前步视为「停机期间过期」，只重排这一步
   * （rescheduleStaleStep）。不传 = 不做重启重排（直接调 advanceRun 的测试 / 脚本）。
   */
  workerStartedAt?: Date;
};

export type ResolvedStep = {
  index: number;
  resolvedVars: VarMap;
  varSources: VarSourceMap;
};

export type AdvanceOutcome =
  /** 没到点 / 当前步在途（accepted，等 message_sent） */
  | "waiting"
  /** 重启重排：过期的当前步改到 now + delay，没发 */
  | "rescheduled"
  /** 当前步已结、排好了下一步 */
  | "progressed"
  /** 最后一步已结 → run finished */
  | "finished"
  /** 已入队（步骤 accepted） */
  | "enqueued"
  /** 没有匹配账号 → skipped，下一步已排 */
  | "skipped"
  /** 只有 rate_limited 的账号 → 顺延到限流结束 */
  | "deferred"
  /** 群已不是 active → run failed / stopped */
  | "run_ended";

export type AdvanceResult = {
  runId: string;
  stepIndex: number;
  outcome: AdvanceOutcome;
};

type Tx = Prisma.TransactionClient;

// ---- 序列定义 -----------------------------------------------------------------------------

/** POST /api/sequences：steps 原样存 Json（形状已由 zod 校验），返回 { id }。 */
export async function createSequence(
  def: SequenceDefinition,
  deps: SequenceServiceDeps = {},
): Promise<{ id: string }> {
  const row = await getDb().sequence.create({
    data: { name: def.name, steps: def.steps },
    select: { id: true },
  });
  deps.log?.info(
    { sequenceId: row.id, name: def.name, steps: def.steps.length },
    "序列已创建",
  );
  return { id: row.id };
}

/** GET /api/sequences：全部序列，按创建顺序（短列表形状）。 */
export async function listSequences(): Promise<SequenceList> {
  const rows = await getDb().sequence.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      steps: parseStoredSteps(r.steps),
      createdAt: r.createdAt.toISOString(),
    })),
    total: rows.length,
  };
}

/** sequences.steps 是 Json：读回来按定义 schema 校验一遍（写入时已校验，这里只是把类型收窄） */
function parseStoredSteps(json: Prisma.JsonValue): SequenceStepDefinition[] {
  return SequenceStepDefinition.array().parse(json);
}

// ---- 取值链（纯函数）------------------------------------------------------------------------

/** 文本里出现的占位符 key，按出现顺序去重。 */
export function extractPlaceholders(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const key = m[1]!;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** 用最终取值替换 `{key}`；解析不到的原样保留（预检保证发送时不会出现）。只认自有属性（见 emptyMap）。 */
export function renderTemplate(template: string, vars: VarMap): string {
  return template.replace(PLACEHOLDER_RE, (whole, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? whole) : whole,
  );
}

/**
 * 以占位符名为下标的取值表：不继承 Object.prototype。占位符名匹配 [A-Za-z0-9_]+，`{constructor}`、`{toString}`、
 * `{__proto__}` 都合法；普通 `{}` 会从原型链上「取到」函数，预检误判为已解析、把函数源码发进群。
 */
function emptyMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/**
 * B1 取值规则。steps 按 index 升序；stepVars 的键是 index 的十进制字符串。
 * 抛 Invalid UNRESOLVED_PLACEHOLDER { stepIndex, key }：按步序、再按 key 在文本里的出现顺序，报第一个解析不到的。
 */
export function resolveVars(
  steps: ReadonlyArray<Pick<SequenceStepDefinition, "index" | "text">>,
  vars: VarMap,
  stepVars: Record<string, VarMap>,
): ResolvedStep[] {
  const current = emptyMap();
  const source = emptyMap();
  for (const [key, value] of Object.entries(vars)) {
    // vars 里的 "" 视为未提供
    if (value === "") continue;
    current[key] = value;
    source[key] = "default";
  }

  const ordered = [...steps].sort((a, b) => a.index - b.index);
  const out: ResolvedStep[] = [];
  for (const step of ordered) {
    const overrides = Object.hasOwn(stepVars, String(step.index))
      ? (stepVars[String(step.index)] ?? {})
      : {};
    for (const [key, value] of Object.entries(overrides)) {
      // stepVars 里的 "" 表示这一步不改
      if (value === "") continue;
      current[key] = value;
      source[key] = `step:${step.index}`;
    }
    const resolvedVars: VarMap = emptyMap();
    const varSources: VarSourceMap = emptyMap();
    for (const key of extractPlaceholders(step.text)) {
      const value = current[key];
      if (value === undefined) {
        throw new Invalid(
          "UNRESOLVED_PLACEHOLDER",
          `第 ${step.index} 步的占位符 {${key}} 没有取值：在 vars 或 stepVars["${step.index}"] 里提供 ${key}`,
          { stepIndex: step.index, key },
        );
      }
      resolvedVars[key] = value;
      varSources[key] = source[key]!;
    }
    out.push({ index: step.index, resolvedVars, varSources });
  }
  return out;
}

// ---- 启动 -------------------------------------------------------------------------------

/**
 * POST /api/groups/:id/sequence-runs（题目 2.3）。校验顺序：群存在（404）且 active（409 GROUP_UNREACHABLE）→
 * 序列存在（422 SEQUENCE_NOT_FOUND）→ 预检取值链（422 UNRESOLVED_PLACEHOLDER）→ INSERT run（撞部分唯一索引 →
 * 409 SEQUENCE_ALREADY_RUNNING）→ 同事务写全部步骤 + ws_events。返回 { runId }（201）。
 */
export async function startRun(
  groupId: string,
  input: StartSequenceRunRequest,
  deps: SequenceServiceDeps = {},
): Promise<{ runId: string }> {
  const clock = deps.clock ?? systemClock;
  const result = await getDb().$transaction(async (tx) => {
    const group = await tx.group.findUnique({
      where: { id: groupId },
      select: { id: true, status: true },
    });
    if (!group) {
      throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除", { groupId });
    }
    if (group.status !== "active") {
      throw new Conflict(
        "GROUP_UNREACHABLE",
        `群已${group.status === "left" ? "退出" : "不可写"}，不能启动序列`,
        { groupId, status: group.status },
      );
    }
    const sequence = await tx.sequence.findUnique({
      where: { id: input.sequenceId },
    });
    if (!sequence) {
      throw new Invalid(
        "SEQUENCE_NOT_FOUND",
        `序列 ${input.sequenceId} 不存在，先创建序列再启动`,
        { sequenceId: input.sequenceId },
      );
    }
    const steps = parseStoredSteps(sequence.steps);
    // 预检在任何写入之前：解析不到就 422，不留运行记录
    const resolved = resolveVars(steps, input.vars, input.stepVars);

    const now = clock.now();
    const runId = randomUUID();
    const vars = JSON.stringify(input.vars);
    const stepVars = JSON.stringify(input.stepVars);
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO sequence_runs (id, sequence_id, group_id, status, current_step_index, vars, step_vars, created_at, updated_at)
      VALUES (${runId}, ${sequence.id}, ${groupId}, 'running', 1, ${vars}::jsonb, ${stepVars}::jsonb, ${now}, ${now})
      ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING
      RETURNING id`;
    if (!inserted[0]) {
      throw new Conflict(
        "SEQUENCE_ALREADY_RUNNING",
        "该群已有一个进行中的序列运行，等它结束后再启动",
        { groupId },
      );
    }

    const byIndex = new Map(resolved.map((r) => [r.index, r]));
    await tx.sequenceRunStep.createMany({
      data: steps.map((step) => {
        const r = byIndex.get(step.index)!;
        return {
          runId,
          index: step.index,
          accountRole: step.accountRole,
          template: step.text,
          delaySeconds: step.delaySeconds,
          status: "pending" as const,
          resolvedVars: r.resolvedVars,
          varSources: r.varSources,
          // 第 1 步在启动后 delaySeconds 秒发送；其余等前一步发出后才排定
          scheduledAt:
            step.index === 1 ? addSeconds(now, step.delaySeconds) : null,
        };
      }),
    });
    await emitRunEvent(tx, {
      id: runId,
      groupId,
      status: "running",
      currentStepIndex: 1,
    });
    return { runId, steps: steps.length };
  });

  deps.log?.info(
    {
      runId: result.runId,
      groupId,
      sequenceId: input.sequenceId,
      steps: result.steps,
    },
    "序列运行已启动",
  );
  return { runId: result.runId };
}

// ---- 读 ---------------------------------------------------------------------------------

/** GET /api/sequence-runs/:id；不存在 → 404 SEQUENCE_RUN_NOT_FOUND。 */
export async function getRun(runId: string): Promise<SequenceRunRead> {
  const row = await getDb().sequenceRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { index: "asc" } } },
  });
  if (!row) {
    throw new NotFound("SEQUENCE_RUN_NOT_FOUND", "序列运行不存在", { runId });
  }
  return toRunRead(row, row.steps);
}

export function toRunRead(
  run: SequenceRun,
  steps: SequenceRunStep[],
): SequenceRunRead {
  return {
    id: run.id,
    sequenceId: run.sequenceId,
    groupId: run.groupId,
    status: run.status,
    currentStepIndex: run.currentStepIndex,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    steps: steps.map(toStepRead),
  };
}

export function toStepRead(step: SequenceRunStep): SequenceRunStepRead {
  return {
    index: step.index,
    status: step.status,
    accountRole: step.accountRole,
    delaySeconds: step.delaySeconds,
    scheduledAt: step.scheduledAt?.toISOString() ?? null,
    sentAt: step.sentAt?.toISOString() ?? null,
    skippedAt: step.skippedAt?.toISOString() ?? null,
    accountId: step.accountId,
    clientMsgId: step.clientMsgId,
    failCode: step.failCode,
    resolvedVars: VarMap.parse(step.resolvedVars),
    varSources: VarSourceMap.parse(step.varSources),
  };
}

// ---- 推进 -------------------------------------------------------------------------------

/**
 * 领取一个到点的 running run 并推进（worker tick 循环调，直到返回 null 或达到批量上限）。
 * 「到点」= 当前步已结（要排下一步）或 pending 且 scheduledAt ≤ now。一条语句 FOR UPDATE OF r SKIP LOCKED：
 * 多副本各领各的；推进与领取同一事务（入队只是写库，没有外部调用，行锁不跨越 HTTP），commit 即释放。
 */
export async function advanceNextDue(
  deps: SequenceAdvanceDeps,
): Promise<AdvanceResult | null> {
  const clock = deps.clock ?? systemClock;
  const result = await getDb().$transaction(async (tx) => {
    const now = clock.now();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM sequence_runs r
      JOIN sequence_run_steps s ON s.run_id = r.id AND s.index = r.current_step_index
      WHERE r.status = 'running'
        AND (
          s.status IN ('sent', 'skipped', 'failed')
          OR (s.status = 'pending' AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= ${now})
        )
      ORDER BY s.scheduled_at NULLS FIRST, r.created_at, r.id
      LIMIT 1
      FOR UPDATE OF r SKIP LOCKED`;
    const id = rows[0]?.id;
    if (!id) return null;
    return advanceRunInTx(tx, id, now, deps);
  });
  if (result) logAdvance(deps, result);
  return result;
}

/** 推进指定的 run（锁住它的行；测试 / 脚本用）。不存在或不是 running → null。 */
export async function advanceRun(
  runId: string,
  deps: SequenceAdvanceDeps,
): Promise<AdvanceResult | null> {
  const clock = deps.clock ?? systemClock;
  const result = await getDb().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM sequence_runs WHERE id = ${runId} AND status = 'running' FOR UPDATE`;
    if (!rows[0]) return null;
    return advanceRunInTx(tx, runId, clock.now(), deps);
  });
  if (result) logAdvance(deps, result);
  return result;
}

function logAdvance(deps: SequenceAdvanceDeps, result: AdvanceResult): void {
  if (result.outcome === "waiting") return;
  deps.log?.info(result, "序列运行已推进");
}

/**
 * 「已过期」判定 + 重排，只在 worker 实例首次接手这一步时生效：步骤 pending、已排期、且排定时刻早于本 worker
 * 实例的启动时刻 —— 到点时没有任何进程活着，就是停机期间过期的那一步。改为 now + 该步 delaySeconds（重启时刻 +
 * delay），返回 true；后续步骤的 scheduledAt 仍为 null，等它发出后再按「前一步发出后 + delay」排。
 * 重排后 scheduledAt > workerStartedAt，同一步不会再被判为过期；本 worker 启动之后才排定的步（scheduledAt ≥
 * workerStartedAt）到点就发，不受影响。
 */
export function rescheduleStaleStep(
  step: Pick<SequenceRunStep, "status" | "scheduledAt" | "delaySeconds">,
  now: Date,
  workerStartedAt: Date,
): Date | null {
  if (step.status !== "pending" || step.scheduledAt === null) return null;
  if (step.scheduledAt.getTime() >= workerStartedAt.getTime()) return null;
  return addSeconds(now, step.delaySeconds);
}

/**
 * 事务体：调用方已锁住 run 行。幂等 —— 每个分支都让 run 的状态前进（或什么都不改并返回 waiting），
 * 进程死在任何一次 commit 之后，下一次 tick 从库里的状态继续。
 */
export async function advanceRunInTx(
  tx: Tx,
  runId: string,
  now: Date,
  deps: SequenceAdvanceDeps,
): Promise<AdvanceResult | null> {
  const clock = deps.clock ?? systemClock;
  const run = await tx.sequenceRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { index: "asc" } } },
  });
  if (!run || run.status !== "running") return null;
  const step = run.steps.find((s) => s.index === run.currentStepIndex);
  if (!step) return null;
  const done = (outcome: AdvanceOutcome): AdvanceResult => ({
    runId,
    stepIndex: step.index,
    outcome,
  });

  // 1. 当前步已结但 run 没推进（终态级联把它改 skipped、或上次进程死在「步骤已结、下一步未排」之后）
  if (
    step.status === "sent" ||
    step.status === "skipped" ||
    step.status === "failed"
  ) {
    const basis = step.sentAt ?? step.skippedAt ?? now;
    const finished = await scheduleNext(tx, run, step, basis, now);
    return done(finished ? "finished" : "progressed");
  }
  // 2. 在途：等 message_sent（onOutboundSettled 会推进）
  if (step.status !== "pending") return done("waiting");
  if (step.scheduledAt === null) {
    // 不该发生（当前步总是排了期）：按此刻 + delay 补排，让状态能前进
    await tx.sequenceRunStep.update({
      where: { id: step.id },
      data: { scheduledAt: addSeconds(now, step.delaySeconds) },
    });
    return done("rescheduled");
  }
  // 3. 重启重排：停机期间过期的当前步只重排这一步
  if (deps.workerStartedAt) {
    const rescheduled = rescheduleStaleStep(step, now, deps.workerStartedAt);
    if (rescheduled) {
      await tx.sequenceRunStep.update({
        where: { id: step.id },
        data: { scheduledAt: rescheduled },
      });
      return done("rescheduled");
    }
  }
  if (step.scheduledAt.getTime() > now.getTime()) return done("waiting");

  // 4. 到点：群还能写吗
  const group = await tx.group.findUnique({
    where: { id: run.groupId },
    select: { status: true },
  });
  if (!group || group.status !== "active") {
    await endRun(
      tx,
      run,
      group?.status === "unreachable" ? "stopped" : "failed",
      now,
    );
    return done("run_ended");
  }

  // 5. 选账号
  const choice = await pickAccount(tx, run.groupId, step.accountRole, now);
  if (choice.kind === "deferred") {
    await tx.sequenceRunStep.update({
      where: { id: step.id },
      data: { scheduledAt: choice.until },
    });
    return done("deferred");
  }
  if (choice.kind === "none") {
    await skipStep(tx, run, step, now, NO_ACCOUNT_FAIL_CODE);
    return done("skipped");
  }

  // 6. 入队（同一事务）：outbox 的校验可能拒绝（账号刚变、群刚不可写）—— 拒绝是 throw 的领域异常，
  //    还没写任何东西，事务仍可用：按码分流，不让一个 run 卡死
  try {
    const { clientMsgId } = await deps.enqueue(
      tx,
      {
        groupId: run.groupId,
        accountId: choice.accountId,
        text: renderTemplate(step.template, VarMap.parse(step.resolvedVars)),
        source: "sequence",
      },
      { clock },
    );
    await tx.sequenceRunStep.update({
      where: { id: step.id },
      data: {
        status: "accepted",
        accountId: choice.accountId,
        clientMsgId,
      },
    });
    return done("enqueued");
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    const code: ErrorCode = err.code;
    if (code === "GROUP_UNREACHABLE" || code === "GROUP_NOT_FOUND") {
      await endRun(tx, run, "failed", now);
      return done("run_ended");
    }
    // ACCOUNT_NOT_IN_GROUP / ACCOUNT_UNAVAILABLE / ACCOUNT_NOT_FOUND：这一步没有可用账号
    await skipStep(tx, run, step, now, code);
    return done("skipped");
  }
}

type AccountChoice =
  | { kind: "online"; accountId: string }
  | { kind: "deferred"; until: Date }
  | { kind: "none" };

/**
 * B1 选账号：admin = 群里 role ∈ {creator, admin} 且 online（优先 admin，再 creator，各自按 accountId 字典序）；
 * member = role = member 且 online 按 accountId 字典序取第一个。没有 online 但有 rate_limited 的 → 顺延到最早的
 * rateLimitedUntil（已过期但还没被恢复 worker 转回 online 的，过 RATE_LIMIT_RECHECK_MS 再看）；一个都没有 → none。
 */
async function pickAccount(
  tx: Tx,
  groupId: string,
  role: SequenceRunStep["accountRole"],
  now: Date,
): Promise<AccountChoice> {
  const members = await tx.groupMember.findMany({
    where: {
      groupId,
      accountId: { not: null },
      role: role === "admin" ? { in: ["admin", "creator"] } : "member",
    },
    include: {
      account: { select: { id: true, status: true, rateLimitedUntil: true } },
    },
  });
  const rank = (r: string): number => (r === "admin" ? 0 : 1);
  const online = members
    .filter((m) => m.account?.status === "online")
    .sort(
      (a, b) =>
        rank(a.role) - rank(b.role) ||
        a.account!.id.localeCompare(b.account!.id),
    );
  if (online[0]) return { kind: "online", accountId: online[0].account!.id };

  const limited = members
    .filter((m) => m.account?.status === "rate_limited")
    .map((m) => m.account!.rateLimitedUntil?.getTime() ?? now.getTime());
  if (limited.length > 0) {
    const until = Math.max(
      Math.min(...limited),
      now.getTime() + RATE_LIMIT_RECHECK_MS,
    );
    return { kind: "deferred", until: new Date(until) };
  }
  return { kind: "none" };
}

/** skipped：有时间戳，视为此刻「发出」，进度照常推进。 */
async function skipStep(
  tx: Tx,
  run: SequenceRun,
  step: SequenceRunStep,
  now: Date,
  failCode: string,
): Promise<void> {
  await tx.sequenceRunStep.update({
    where: { id: step.id },
    data: { status: "skipped", skippedAt: now, failCode },
  });
  await scheduleNext(tx, run, step, now, now);
}

/**
 * 当前步已结：下一步 scheduledAt = basis + 它的 delaySeconds、currentStepIndex 前进；最后一步 → run finished。
 * 返回是否结束了 run。每次推进写一行 ws_events sequence_run。
 */
async function scheduleNext(
  tx: Tx,
  run: Pick<SequenceRun, "id" | "groupId">,
  step: Pick<SequenceRunStep, "index">,
  basis: Date,
  now: Date,
): Promise<boolean> {
  const next = await tx.sequenceRunStep.findUnique({
    where: { runId_index: { runId: run.id, index: step.index + 1 } },
    select: { id: true, delaySeconds: true, index: true },
  });
  if (!next) {
    await tx.sequenceRun.update({
      where: { id: run.id },
      data: { status: "finished", finishedAt: now },
    });
    await emitRunEvent(tx, {
      id: run.id,
      groupId: run.groupId,
      status: "finished",
      currentStepIndex: step.index,
    });
    return true;
  }
  await tx.sequenceRunStep.update({
    where: { id: next.id },
    data: { scheduledAt: addSeconds(basis, next.delaySeconds) },
  });
  await tx.sequenceRun.update({
    where: { id: run.id },
    data: { currentStepIndex: next.index },
  });
  await emitRunEvent(tx, {
    id: run.id,
    groupId: run.groupId,
    status: "running",
    currentStepIndex: next.index,
  });
  return false;
}

async function endRun(
  tx: Tx,
  run: SequenceRun,
  status: "failed" | "stopped",
  now: Date,
): Promise<void> {
  await tx.sequenceRun.update({
    where: { id: run.id },
    data: { status, finishedAt: now },
  });
  await emitRunEvent(tx, {
    id: run.id,
    groupId: run.groupId,
    status,
    currentStepIndex: run.currentStepIndex,
  });
}

// ---- 出站消息终局 → 步骤（outbox-service.settle 在同一事务里调）------------------------------------

/**
 * 消息进终局：sent → 步骤 sent（sentAt = 此刻，即收到 message_sent 的时刻），下一步以此刻为基准排期；failed / cancelled → 步骤 failed
 * （failCode = 消息的 failCode），下一步以此刻为基准。幂等：步骤不是 accepted（已结 / 终态级联已改 skipped）就不动。
 * 锁 run 行（FOR UPDATE）与 worker 的领取互斥；run 已不是 running（群 unreachable → stopped）时只改步骤、不排下一步。
 */
export async function onOutboundSettled(
  tx: Tx,
  message: Pick<Message, "clientMsgId" | "deliveryStatus" | "failCode">,
  now: Date,
): Promise<boolean> {
  if (message.clientMsgId === null) return false;
  if (
    message.deliveryStatus !== "sent" &&
    message.deliveryStatus !== "failed" &&
    message.deliveryStatus !== "cancelled"
  ) {
    return false;
  }
  const found = await tx.sequenceRunStep.findUnique({
    where: { clientMsgId: message.clientMsgId },
    select: { id: true, runId: true },
  });
  if (!found) return false;
  await tx.$queryRaw`SELECT id FROM sequence_runs WHERE id = ${found.runId} FOR UPDATE`;
  // 锁到之后重读：worker 可能刚在同一行上推进过
  const step = await tx.sequenceRunStep.findUnique({ where: { id: found.id } });
  if (!step || step.status !== "accepted") return false;

  const sent = message.deliveryStatus === "sent";
  await tx.sequenceRunStep.update({
    where: { id: step.id },
    data: sent
      ? { status: "sent", sentAt: now }
      : {
          status: "failed",
          failCode: message.failCode ?? message.deliveryStatus,
        },
  });
  const run = await tx.sequenceRun.findUniqueOrThrow({
    where: { id: step.runId },
  });
  if (run.status === "running" && run.currentStepIndex === step.index) {
    await scheduleNext(tx, run, step, now, now);
  }
  return true;
}

// ---- 辅助 -------------------------------------------------------------------------------

function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1_000);
}

/** ws_events sequence_run：{ runId, groupId, status, currentStepIndex }（题目 2.3） */
async function emitRunEvent(
  tx: Tx,
  run: {
    id: string;
    groupId: string;
    status: SequenceRun["status"];
    currentStepIndex: number;
  },
): Promise<void> {
  await emitWsEvent(tx, "sequence_run", {
    runId: run.id,
    groupId: run.groupId,
    status: run.status,
    currentStepIndex: run.currentStepIndex,
  });
}
