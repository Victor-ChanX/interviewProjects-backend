// 建群 job 的状态机（题目 A3 / B2 / A2 的 NOT_MEMBER_YET 行；issue #11）。leave-all（#16）复用这里的
// 领取 / 回收 / 推进框架（advanceJob 按 jobs.kind 分派），只需再加一个 kind 的步骤函数。
//
// 一切从一个事实出发：进程随时会死。所以**每一步都落库**（jobs.step + jobs.state 是唯一的进度真相），
// 顺序永远是 写库（意图）→ commit → 调网关 → 写库（结果）；重启后从 step / state 继续，不从头来：
//
//   create   网关 POST /groups → 写 groups.gatewayGroupId + 成员表写创建者（role creator，platformUserId 取账号的）。
//            意图 = step 已是 create 且 gatewayGroupId 为空；结果不明时重试会在网关多建一个没人用的群
//            （网关没有「按幂等键查群」的接口，无法对账），有界重试后记 GATEWAY_UNAVAILABLE。
//   invite   POST /groups/:id/invite → state.invite = { link, readyAt }，转 join，nextRunAt = readyAt
//            （网关已经说了多久后可用，等到再 join，不白打一次）。
//   join     每个成员一步（step = join，state.currentAccountId 记账号；API 拼成 join:<accountId>）：
//            pending → POST join：202 → accepted（acceptedAt）；ALREADY_MEMBER → 视为已入群（成员表自己写一行，
//            网关不会再推 member_joined）；INVITE_NOT_READY → nextRunAt = max(readyAt, now + 250ms) 再试（不 sleep）；
//            INVITE_EXPIRED → 重新申请链接一次（转回 invite，expiredRetries + 1），再过期记 errors；其他 4xx 记 errors。
//            accepted → **不轮询网关**：每 tick 查 group_members（入站 worker #8 收到 member_joined 会写行）；
//            出现 → joined；acceptedAt 起超过 10s 没出现 → job_errors { join, accountId, JOIN_TIMEOUT }。
//   promote  memberAccountIds[0] 已 joined 才调（成员表先确认，避免明知会 NOT_MEMBER_YET 的调用）；
//            调用前先把 promote.calls + 1 落库（崩在调用与记账之间也不会多调），总数 ≤ 2：
//            NOT_MEMBER_YET 且 calls < 2 → 300ms 后再试；仍不行 / NO_PERMISSION / 其他 → 记 errors。
//            200 → 成员表把该账号 role 改 admin + ws_events member_changed(promoted)。
//   finish   有 errors → failed，否则 finished（题目：errors 非空即 failed）。
//
// **一个成员失败，其余成员继续**（本实现的选择，题目只说「job failed」）：JOIN_TIMEOUT / INVITE_EXPIRED / 其他
// 拒绝都只记该成员的 errors 行并处理下一位；全部处理完再 promote（仅当 memberAccountIds[0] 已入群），最后
// 按 errors 定终态。理由：建群 + 拉人是批量操作，一个账号入不了群不该让其余账号也进不去；操作员从
// GET /api/jobs/:jobId 的 errors[] 能精确看到哪几步失败。
//
// 网关不可用（连不上 / 5xx / 504）：结果不明但这几步都可安全重做（join 再调要么 202 要么 ALREADY_MEMBER；
// invite 多申请一条链接无害），按 state.transientFailures 有界退避；超过上限记当前步 GATEWAY_UNAVAILABLE。
//
// 领取：`FOR UPDATE SKIP LOCKED` 一条语句（多副本各领各的），标 claimedBy / lockedAt 后 commit，再跑步骤；
// 跑完释放领取并按 outcome 写 nextRunAt。lockedAt 过旧仍未释放 = 领取者死了，回收步骤放回队列（step / state
// 都在库里，接手者从该步继续）。定时器只在 worker 里（多久看一次），排期本身是 jobs.nextRunAt。
import { z } from "zod";

import type { Clock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type { Job, JobStepKind, Prisma } from "../db/generated/client.js";
import {
  type GatewayClient,
  GatewayResponseError,
  GatewayUnreachableError,
} from "./gateway-client.js";
import { emitWsEvent } from "./ws-events.js";

// ---- 常量（都是上限 / 排期，放在文件顶部一眼看全）------------------------------------------

/** 题目 A2：member_joined 超过 10 秒未到 → JOIN_TIMEOUT */
export const JOIN_TIMEOUT_MS = 10_000;
/** 等 member_joined 时多久再查一次成员表 */
export const JOIN_POLL_MS = 200;
/** INVITE_NOT_READY 时至少等这么久再试（readyAt 已过仍 NOT_READY = 两边时钟有偏差） */
export const INVITE_NOT_READY_MIN_WAIT_MS = 250;
/** 题目 B2：INVITE_EXPIRED → 重新申请链接后重试一次 */
export const INVITE_EXPIRED_MAX_RETRIES = 1;
/** 题目 A2：对 promote 的调用总数 ≤ 2 */
export const PROMOTE_MAX_CALLS = 2;
/** NOT_MEMBER_YET 后多久再试 */
export const PROMOTE_RETRY_MS = 300;
/** 网关不可用的有界退避：min(base × 2^n, cap)，超过 MAX 次记 GATEWAY_UNAVAILABLE */
export const TRANSIENT_BASE_MS = 500;
export const TRANSIENT_CAP_MS = 10_000;
export const TRANSIENT_MAX_FAILURES = 5;
/** 步骤里抛了非网关异常（库错 / bug）：退避重试，超过次数记 INTERNAL */
export const CRASH_RETRY_MS = 1_000;
export const CRASH_MAX_FAILURES = 5;
/** lockedAt 早于此仍未释放 → 领取者死了，回收 */
export const STALE_CLAIM_MS = 30_000;
export const DEFAULT_BATCH_SIZE = 10;
/** 一次领取最多连续跑几步（防止一个 job 独占一个 tick） */
export const DEFAULT_MAX_STEPS_PER_CLAIM = 50;

/** 记进 job_errors 的本地码（网关的码原样记：JOIN_TIMEOUT 是题目定的） */
export const JOB_ERROR_CODES = Object.freeze({
  joinTimeout: "JOIN_TIMEOUT",
  gatewayUnavailable: "GATEWAY_UNAVAILABLE",
  /** promote 已调过 2 次但结果都没记下来（进程两次都死在调用与记账之间） */
  promoteUnknown: "PROMOTE_RESULT_UNKNOWN",
  /** 账号在建群途中已没有 platformUserId（被标离线 / 终态） */
  accountNotConnected: "ACCOUNT_NOT_CONNECTED",
  internal: "INTERNAL",
});

// ---- 类型 ----------------------------------------------------------------------------

export type CreateGroupJobInput = {
  creatorAccountId: string;
  memberAccountIds: string[];
};

const joinProgressSchema = z.object({
  status: z.enum(["pending", "accepted", "joined", "failed"]),
  /** 网关 202 的时刻（ISO）；JOIN_TIMEOUT 从这里算 */
  acceptedAt: z.string().nullable(),
});
export type JoinProgress = z.infer<typeof joinProgressSchema>;

/** jobs.state 的形状（create_group）。改这里要考虑存量 running 的 job：只加可选字段 / 带默认值。 */
const createGroupStateSchema = z.object({
  memberAccountIds: z.array(z.string()),
  /** 当前 join / leave 步骤的账号；API 层拼 step 字符串用 */
  currentAccountId: z.string().nullable(),
  invite: z.object({
    link: z.string().nullable(),
    /** 链接可用时刻（ISO） */
    readyAt: z.string().nullable(),
    /** 因 INVITE_EXPIRED 重新申请过几次 */
    expiredRetries: z.number().int(),
  }),
  joins: z.record(z.string(), joinProgressSchema),
  promote: z.object({
    /** 已发起的调用数（调用前 + 1） */
    calls: z.number().int(),
    /** 最近一次调用的结果：null = 发出后还没记账 */
    lastOutcome: z.enum(["ok", "error"]).nullable(),
  }),
  transientFailures: z.number().int(),
  crashes: z.number().int().default(0),
});
export type CreateGroupState = z.output<typeof createGroupStateSchema>;

export function initialCreateGroupState(
  input: CreateGroupJobInput,
): CreateGroupState {
  return {
    memberAccountIds: [...input.memberAccountIds],
    currentAccountId: null,
    invite: { link: null, readyAt: null, expiredRetries: 0 },
    joins: Object.fromEntries(
      input.memberAccountIds.map((id) => [
        id,
        { status: "pending", acceptedAt: null } satisfies JoinProgress,
      ]),
    ),
    promote: { calls: 0, lastOutcome: null },
    transientFailures: 0,
    crashes: 0,
  };
}

export type JobGateway = Pick<
  GatewayClient,
  "createGroup" | "createInvite" | "joinGroup" | "promote"
>;

export type JobServiceDeps = {
  clock: Clock;
  gateway: JobGateway;
  workerId: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
};

/** 一步的结果：continue = 下一步立刻可跑；wait = 到 until 再领；done = 已终态 */
export type StepOutcome =
  | { kind: "continue" }
  | { kind: "wait"; until: Date }
  | { kind: "done"; status: "finished" | "failed" };

export type AdvanceResult = {
  jobId: string;
  steps: number;
  outcome: StepOutcome["kind"] | "lost";
};

// ---- 领取 / 回收 / 释放 ---------------------------------------------------------------------

/**
 * 一条语句领一批（交互式事务里 $queryRaw 标签模板；手写 SQL 用数据库列名）：running、没人领、到点了。
 * `FOR UPDATE SKIP LOCKED`：别的副本正在领的行跳过；claimedBy 挡住跨 tick 的重复领取。commit 后才跑步骤。
 */
export async function claimJobs(
  workerId: string,
  now: Date,
  limit: number = DEFAULT_BATCH_SIZE,
): Promise<Job[]> {
  return getDb().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM jobs
      WHERE status = 'running'
        AND claimed_by IS NULL
        AND (next_run_at IS NULL OR next_run_at <= ${now})
      ORDER BY next_run_at NULLS FIRST, created_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.job.updateMany({
      where: { id: { in: ids } },
      data: { claimedBy: workerId, lockedAt: now, attempts: { increment: 1 } },
    });
    const jobs = await tx.job.findMany({ where: { id: { in: ids } } });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return ids.map((id) => byId.get(id)!);
  });
}

/** lockedAt 早于 now − STALE_CLAIM_MS 仍被占着的 running job：放回队列（step / state 原样，接手者继续）。 */
export async function recoverStaleJobClaims(
  now: Date,
  deps: Pick<JobServiceDeps, "log">,
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const stale = await getDb().job.findMany({
    where: {
      status: "running",
      claimedBy: { not: null },
      lockedAt: { lt: cutoff },
    },
    select: { id: true, claimedBy: true, step: true },
  });
  if (stale.length === 0) return 0;
  await getDb().job.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: {
      claimedBy: null,
      lockedAt: null,
      nextRunAt: now,
      lastError: "领取者未释放（可能死在步骤中途），已回收",
    },
  });
  deps.log?.warn({ jobs: stale }, "回收过期领取的 job");
  return stale.length;
}

/** 释放领取并排期（步骤结果已各自落库） */
async function release(
  jobId: string,
  workerId: string,
  nextRunAt: Date,
  lastError: string | null,
): Promise<void> {
  await getDb().job.updateMany({
    where: { id: jobId, claimedBy: workerId },
    data: { claimedBy: null, lockedAt: null, nextRunAt, lastError },
  });
}

// ---- 推进 -----------------------------------------------------------------------------

/**
 * 推进一个已领取的 job：按 kind 分派，连续跑到 wait / done 或 maxSteps 为止，然后释放领取。
 * 领取标记不属于本 worker（被回收后别人接手）→ outcome = lost，什么都不做。
 * 步骤里抛出的非网关异常：记 state.crashes、退避重试；超过上限记 INTERNAL 并按 errors 收尾。
 */
export async function advanceJob(
  jobId: string,
  deps: JobServiceDeps,
  opts: { maxSteps?: number } = {},
): Promise<AdvanceResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS_PER_CLAIM;
  let steps = 0;
  for (;;) {
    const job = await getDb().job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== "running" || job.claimedBy !== deps.workerId) {
      return { jobId, steps, outcome: "lost" };
    }
    if (steps >= maxSteps) {
      await release(jobId, deps.workerId, deps.clock.now(), null);
      return { jobId, steps, outcome: "continue" };
    }
    let outcome: StepOutcome;
    try {
      outcome = await runStep(job, deps);
    } catch (err) {
      outcome = await onCrash(job, err, deps);
    }
    steps += 1;
    if (outcome.kind === "continue") continue;
    if (outcome.kind === "wait") {
      await release(jobId, deps.workerId, outcome.until, null);
    }
    return { jobId, steps, outcome: outcome.kind };
  }
}

async function runStep(job: Job, deps: JobServiceDeps): Promise<StepOutcome> {
  switch (job.kind) {
    case "create_group":
      return createGroupStep(job, deps);
    case "leave_all":
      // #16 在这里接：leave 步骤函数。现在还没有实现，按错误收尾而不是永远挂着。
      return failWithError(job, deps, {
        step: "leave",
        accountId: null,
        code: JOB_ERROR_CODES.internal,
        message: "leave_all 尚未实现（#16）",
      });
  }
}

async function onCrash(
  job: Job,
  err: unknown,
  deps: JobServiceDeps,
): Promise<StepOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  deps.log?.error({ err, jobId: job.id, step: job.step }, "job 步骤异常");
  const state = parseState(job);
  const crashes = state.crashes + 1;
  if (crashes > CRASH_MAX_FAILURES) {
    return failWithError(job, deps, {
      step: job.step ?? "create",
      accountId: state.currentAccountId,
      code: JOB_ERROR_CODES.internal,
      message,
    });
  }
  await getDb().job.update({
    where: { id: job.id },
    data: { state: toJson({ ...state, crashes }), lastError: message },
  });
  return {
    kind: "wait",
    until: new Date(deps.clock.now().getTime() + CRASH_RETRY_MS),
  };
}

// ---- create_group 的步骤 ---------------------------------------------------------------

function parseState(job: Job): CreateGroupState {
  return createGroupStateSchema.parse(job.state);
}

function toJson(state: CreateGroupState): Prisma.InputJsonObject {
  return state;
}

function parseInput(job: Job): CreateGroupJobInput {
  return z
    .object({
      creatorAccountId: z.string(),
      memberAccountIds: z.array(z.string()),
    })
    .parse(job.input);
}

async function createGroupStep(
  job: Job,
  deps: JobServiceDeps,
): Promise<StepOutcome> {
  const state = parseState(job);
  const input = parseInput(job);
  if (!job.groupId) {
    return failWithError(job, deps, {
      step: "create",
      accountId: null,
      code: JOB_ERROR_CODES.internal,
      message: "job 没有关联的群",
    });
  }
  const ctx: StepCtx = { job, groupId: job.groupId, input, state, deps };
  switch (job.step) {
    case "create":
    case null:
      return stepCreate(ctx);
    case "invite":
      return stepInvite(ctx);
    case "join":
      return stepJoin(ctx);
    case "promote":
      return stepPromote(ctx);
    case "leave":
      return failWithError(job, deps, {
        step: "leave",
        accountId: null,
        code: JOB_ERROR_CODES.internal,
        message: "create_group job 不该有 leave 步",
      });
  }
}

type StepCtx = {
  job: Job;
  groupId: string;
  input: CreateGroupJobInput;
  state: CreateGroupState;
  deps: JobServiceDeps;
};

/** 写一步的进度（state / step / nextRunAt）；同一事务里可附带别的写。 */
async function persist(
  ctx: StepCtx,
  patch: {
    step?: JobStepKind;
    state: CreateGroupState;
    lastError?: string | null;
  },
  also?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await getDb().$transaction(async (tx) => {
    await tx.job.update({
      where: { id: ctx.job.id },
      data: {
        ...(patch.step !== undefined ? { step: patch.step } : {}),
        state: toJson(patch.state),
        ...(patch.lastError !== undefined
          ? { lastError: patch.lastError }
          : {}),
      },
    });
    if (patch.step !== undefined && patch.step !== ctx.job.step) {
      await emitWsEvent(tx, "job", {
        jobId: ctx.job.id,
        groupId: ctx.groupId,
        kind: ctx.job.kind,
        status: "running",
        step: stepString(patch.step, patch.state.currentAccountId),
      });
    }
    if (also) await also(tx);
  });
}

function stepString(step: JobStepKind, accountId: string | null): string {
  return step === "join" || step === "leave"
    ? `${step}:${accountId ?? "?"}`
    : step;
}

async function stepCreate(ctx: StepCtx): Promise<StepOutcome> {
  const { deps, input, state } = ctx;
  const group = await getDb().group.findUniqueOrThrow({
    where: { id: ctx.groupId },
    select: { gatewayGroupId: true },
  });
  if (group.gatewayGroupId !== null) {
    // 上次死在写 gatewayGroupId 之后、转 invite 之前：不再建
    await persist(ctx, { step: "invite", state });
    return { kind: "continue" };
  }
  const creator = await getDb().account.findUnique({
    where: { id: input.creatorAccountId },
    select: { platformUserId: true },
  });
  if (!creator?.platformUserId) {
    return failWithError(ctx.job, deps, {
      step: "create",
      accountId: null,
      code: JOB_ERROR_CODES.accountNotConnected,
      message: `群主 ${input.creatorAccountId} 没有 platformUserId（未 connect 或已离线）`,
    });
  }
  const platformUserId = creator.platformUserId;

  let created: { groupId: string };
  try {
    created = await deps.gateway.createGroup({
      creatorAccountId: input.creatorAccountId,
    });
  } catch (err) {
    return onGatewayError(ctx, err, { step: "create", accountId: null });
  }

  // 结果落库：gatewayGroupId + 创建者成员行（题目 A3：创建者在建群成功后写入，role = creator）+ 转 invite
  const now = deps.clock.now();
  await persist(
    ctx,
    { step: "invite", state: { ...state, transientFailures: 0 } },
    async (tx) => {
      await tx.group.update({
        where: { id: ctx.groupId },
        data: { gatewayGroupId: created.groupId },
      });
      await tx.groupMember.upsert({
        where: {
          groupId_platformUserId: { groupId: ctx.groupId, platformUserId },
        },
        create: {
          groupId: ctx.groupId,
          platformUserId,
          accountId: input.creatorAccountId,
          role: "creator",
          joinedAt: now,
        },
        update: { accountId: input.creatorAccountId, role: "creator" },
      });
      await emitWsEvent(tx, "member_changed", {
        groupId: ctx.groupId,
        platformUserId,
        accountId: input.creatorAccountId,
        change: "joined",
      });
    },
  );
  deps.log?.info(
    {
      jobId: ctx.job.id,
      groupId: ctx.groupId,
      gatewayGroupId: created.groupId,
    },
    "网关已建群",
  );
  return { kind: "continue" };
}

async function stepInvite(ctx: StepCtx): Promise<StepOutcome> {
  const { deps, state } = ctx;
  const gatewayGroupId = await requireGatewayGroupId(ctx);
  let invite: { inviteLink: string; readyAfterMs: number };
  try {
    invite = await deps.gateway.createInvite(gatewayGroupId);
  } catch (err) {
    return onGatewayError(ctx, err, { step: "invite", accountId: null });
  }
  const now = deps.clock.now();
  const readyAt = new Date(now.getTime() + invite.readyAfterMs);
  const next = nextPendingMember(state);
  const nextState: CreateGroupState = {
    ...state,
    invite: {
      ...state.invite,
      link: invite.inviteLink,
      readyAt: readyAt.toISOString(),
    },
    currentAccountId: next,
    transientFailures: 0,
  };
  if (next === null) {
    // 没有待 join 的成员了（重新申请链接时所有人已处理完）：直接去 promote
    await persist(ctx, {
      step: "promote",
      state: { ...nextState, currentAccountId: null },
    });
    return { kind: "continue" };
  }
  await persist(ctx, { step: "join", state: nextState });
  // 网关说了 readyAfterMs：到点再 join，不白打一次
  return invite.readyAfterMs > 0
    ? { kind: "wait", until: readyAt }
    : { kind: "continue" };
}

/** 下一个还没处理完的成员（pending / accepted），按 memberAccountIds 顺序 */
function nextPendingMember(state: CreateGroupState): string | null {
  for (const id of state.memberAccountIds) {
    const p = state.joins[id];
    if (p && (p.status === "pending" || p.status === "accepted")) return id;
  }
  return null;
}

async function stepJoin(ctx: StepCtx): Promise<StepOutcome> {
  const { state } = ctx;
  const accountId = state.currentAccountId ?? nextPendingMember(state);
  if (accountId === null) return toPromote(ctx);
  const progress = state.joins[accountId];
  if (
    !progress ||
    progress.status === "joined" ||
    progress.status === "failed"
  ) {
    return toNextMember(ctx, accountId);
  }
  if (state.currentAccountId !== accountId) {
    await persist(ctx, { state: { ...state, currentAccountId: accountId } });
    ctx.state = { ...state, currentAccountId: accountId };
  }
  return progress.status === "pending"
    ? joinRequest(ctx, accountId)
    : joinWait(ctx, accountId, progress);
}

/** pending → POST join */
async function joinRequest(
  ctx: StepCtx,
  accountId: string,
): Promise<StepOutcome> {
  const { deps, state } = ctx;
  const gatewayGroupId = await requireGatewayGroupId(ctx);
  if (state.invite.link === null) {
    // 链接被判过期后清掉了：回 invite 重新申请
    await persist(ctx, { step: "invite", state });
    return { kind: "continue" };
  }
  const now = deps.clock.now();
  try {
    await deps.gateway.joinGroup(gatewayGroupId, {
      accountId,
      inviteLink: state.invite.link,
    });
  } catch (err) {
    if (err instanceof GatewayResponseError) {
      switch (err.code) {
        case "ALREADY_MEMBER":
          // 题目 B2：视为成功。网关不会再推 member_joined，成员行自己写
          return markJoined(ctx, accountId, { viaAlreadyMember: true });
        case "INVITE_NOT_READY": {
          const readyAt = state.invite.readyAt
            ? new Date(state.invite.readyAt)
            : now;
          const until = new Date(
            Math.max(
              readyAt.getTime(),
              now.getTime() + INVITE_NOT_READY_MIN_WAIT_MS,
            ),
          );
          deps.log?.info(
            { jobId: ctx.job.id, accountId, until },
            "邀请链接未就绪，稍后再 join",
          );
          return { kind: "wait", until };
        }
        case "INVITE_EXPIRED": {
          if (state.invite.expiredRetries < INVITE_EXPIRED_MAX_RETRIES) {
            deps.log?.warn(
              { jobId: ctx.job.id, accountId },
              "邀请链接已过期，重新申请一次",
            );
            await persist(ctx, {
              step: "invite",
              state: {
                ...state,
                invite: {
                  link: null,
                  readyAt: null,
                  expiredRetries: state.invite.expiredRetries + 1,
                },
              },
            });
            return { kind: "continue" };
          }
          return memberFailed(ctx, accountId, err.code, err.message);
        }
        default:
          if (err.status < 500) {
            return memberFailed(ctx, accountId, err.code, err.message);
          }
      }
    }
    return onGatewayError(ctx, err, { step: "join", accountId });
  }
  // 202：受理，进入等待（成员表由入站 worker 写）
  await persist(ctx, {
    state: {
      ...state,
      joins: {
        ...state.joins,
        [accountId]: { status: "accepted", acceptedAt: now.toISOString() },
      },
      transientFailures: 0,
    },
  });
  return { kind: "wait", until: new Date(now.getTime() + JOIN_POLL_MS) };
}

/** accepted → 查成员表；超过 10s → JOIN_TIMEOUT */
async function joinWait(
  ctx: StepCtx,
  accountId: string,
  progress: JoinProgress,
): Promise<StepOutcome> {
  const { deps } = ctx;
  const member = await getDb().groupMember.findFirst({
    where: { groupId: ctx.groupId, accountId },
    select: { platformUserId: true },
  });
  if (member) return markJoined(ctx, accountId, { viaAlreadyMember: false });
  const now = deps.clock.now();
  const acceptedAt = progress.acceptedAt ? new Date(progress.acceptedAt) : now;
  if (now.getTime() - acceptedAt.getTime() > JOIN_TIMEOUT_MS) {
    return memberFailed(
      ctx,
      accountId,
      JOB_ERROR_CODES.joinTimeout,
      `账号 ${accountId} 受理后 ${JOIN_TIMEOUT_MS / 1000} 秒内没有收到 member_joined`,
    );
  }
  return { kind: "wait", until: new Date(now.getTime() + JOIN_POLL_MS) };
}

/** 该成员已入群：state 记 joined（ALREADY_MEMBER 时顺带写成员行），转下一位 */
async function markJoined(
  ctx: StepCtx,
  accountId: string,
  opts: { viaAlreadyMember: boolean },
): Promise<StepOutcome> {
  const { deps, state } = ctx;
  const joined: CreateGroupState = {
    ...state,
    joins: {
      ...state.joins,
      [accountId]: { ...state.joins[accountId]!, status: "joined" },
    },
    transientFailures: 0,
  };
  let platformUserId: string | null = null;
  if (opts.viaAlreadyMember) {
    const account = await getDb().account.findUnique({
      where: { id: accountId },
      select: { platformUserId: true },
    });
    if (!account?.platformUserId) {
      return memberFailed(
        ctx,
        accountId,
        JOB_ERROR_CODES.accountNotConnected,
        `账号 ${accountId} 没有 platformUserId，无法写成员行`,
      );
    }
    platformUserId = account.platformUserId;
  }
  const now = deps.clock.now();
  await persist(ctx, { state: joined }, async (tx) => {
    if (platformUserId === null) return;
    const existing = await tx.groupMember.findUnique({
      where: {
        groupId_platformUserId: { groupId: ctx.groupId, platformUserId },
      },
      select: { platformUserId: true },
    });
    if (existing) return;
    await tx.groupMember.create({
      data: {
        groupId: ctx.groupId,
        platformUserId,
        accountId,
        role: "member",
        joinedAt: now,
      },
    });
    await emitWsEvent(tx, "member_changed", {
      groupId: ctx.groupId,
      platformUserId,
      accountId,
      change: "joined",
    });
  });
  ctx.state = joined;
  deps.log?.info(
    {
      jobId: ctx.job.id,
      groupId: ctx.groupId,
      accountId,
      viaAlreadyMember: opts.viaAlreadyMember,
    },
    "成员已入群",
  );
  return toNextMember(ctx, accountId);
}

/** 该成员失败：记 job_errors { join, accountId, code }，state 记 failed，继续下一位（见文件头的选择） */
async function memberFailed(
  ctx: StepCtx,
  accountId: string,
  code: string,
  message: string,
): Promise<StepOutcome> {
  const { deps, state } = ctx;
  const failed: CreateGroupState = {
    ...state,
    joins: {
      ...state.joins,
      [accountId]: { ...state.joins[accountId]!, status: "failed" },
    },
    transientFailures: 0,
  };
  await persist(ctx, { state: failed }, async (tx) => {
    await tx.jobError.create({
      data: { jobId: ctx.job.id, step: "join", accountId, code, message },
    });
  });
  ctx.state = failed;
  deps.log?.warn(
    { jobId: ctx.job.id, groupId: ctx.groupId, accountId, code },
    "成员 join 失败",
  );
  return toNextMember(ctx, accountId);
}

async function toNextMember(ctx: StepCtx, done: string): Promise<StepOutcome> {
  const state = ctx.state;
  const next = nextPendingMember(state);
  if (next === null || next === done) return toPromote(ctx);
  await persist(ctx, {
    step: "join",
    state: { ...state, currentAccountId: next },
  });
  return { kind: "continue" };
}

async function toPromote(ctx: StepCtx): Promise<StepOutcome> {
  await persist(ctx, {
    step: "promote",
    state: { ...ctx.state, currentAccountId: null },
  });
  return { kind: "continue" };
}

async function stepPromote(ctx: StepCtx): Promise<StepOutcome> {
  const { deps, input, state } = ctx;
  const target = state.memberAccountIds[0];
  if (target === undefined || state.joins[target]?.status !== "joined") {
    // 目标没入群（errors 里已有它的记录，或根本没有成员）：不调 promote，直接收尾
    return finish(ctx);
  }
  if (state.promote.lastOutcome !== null) return finish(ctx);
  if (state.promote.calls >= PROMOTE_MAX_CALLS) {
    // 两次都发出去了、都没记下结果（两次都死在调用与记账之间）：不再调，记下来让人看
    return recordPromoteError(
      ctx,
      JOB_ERROR_CODES.promoteUnknown,
      `promote 已调用 ${state.promote.calls} 次，结果未记账`,
    );
  }
  const gatewayGroupId = await requireGatewayGroupId(ctx);
  // 写库（意图）→ 调用：崩在中间也不会超过 2 次
  const attempted: CreateGroupState = {
    ...state,
    promote: { ...state.promote, calls: state.promote.calls + 1 },
  };
  await persist(ctx, { state: attempted });
  ctx.state = attempted;
  try {
    await deps.gateway.promote(gatewayGroupId, {
      byAccountId: input.creatorAccountId,
      accountId: target,
    });
  } catch (err) {
    if (err instanceof GatewayResponseError) {
      if (
        err.code === "NOT_MEMBER_YET" &&
        attempted.promote.calls < PROMOTE_MAX_CALLS
      ) {
        deps.log?.warn(
          { jobId: ctx.job.id, accountId: target },
          "promote：对方尚未入群，稍后再试一次",
        );
        return {
          kind: "wait",
          until: new Date(deps.clock.now().getTime() + PROMOTE_RETRY_MS),
        };
      }
      if (err.status < 500 || attempted.promote.calls >= PROMOTE_MAX_CALLS) {
        return recordPromoteError(ctx, err.code, err.message);
      }
    }
    if (attempted.promote.calls >= PROMOTE_MAX_CALLS) {
      return recordPromoteError(
        ctx,
        JOB_ERROR_CODES.gatewayUnavailable,
        describe(err),
      );
    }
    return onGatewayError(ctx, err, { step: "promote", accountId: null });
  }
  // 200：成员表 role → admin
  const account = await getDb().account.findUnique({
    where: { id: target },
    select: { platformUserId: true },
  });
  const ok: CreateGroupState = {
    ...attempted,
    promote: { ...attempted.promote, lastOutcome: "ok" },
    transientFailures: 0,
  };
  await persist(ctx, { state: ok }, async (tx) => {
    const { count } = await tx.groupMember.updateMany({
      where: { groupId: ctx.groupId, accountId: target },
      data: { role: "admin" },
    });
    if (count > 0 && account?.platformUserId) {
      await emitWsEvent(tx, "member_changed", {
        groupId: ctx.groupId,
        platformUserId: account.platformUserId,
        accountId: target,
        change: "promoted",
      });
    }
  });
  ctx.state = ok;
  deps.log?.info(
    { jobId: ctx.job.id, groupId: ctx.groupId, accountId: target },
    "已提升为管理员",
  );
  return finish(ctx);
}

async function recordPromoteError(
  ctx: StepCtx,
  code: string,
  message: string,
): Promise<StepOutcome> {
  const failed: CreateGroupState = {
    ...ctx.state,
    promote: { ...ctx.state.promote, lastOutcome: "error" },
  };
  await persist(ctx, { state: failed }, async (tx) => {
    await tx.jobError.create({
      data: {
        jobId: ctx.job.id,
        step: "promote",
        accountId: null,
        code,
        message,
      },
    });
  });
  ctx.state = failed;
  ctx.deps.log?.warn(
    { jobId: ctx.job.id, groupId: ctx.groupId, code },
    "promote 失败",
  );
  return finish(ctx);
}

// ---- 收尾与网关错误 -------------------------------------------------------------------------

/** 终态：有 errors → failed，否则 finished；释放领取、写 finishedAt、推 ws 事件 */
async function finish(ctx: StepCtx): Promise<StepOutcome> {
  const { deps } = ctx;
  const now = deps.clock.now();
  const status = await getDb().$transaction(async (tx) => {
    const errors = await tx.jobError.count({ where: { jobId: ctx.job.id } });
    const status = errors > 0 ? "failed" : "finished";
    await tx.job.update({
      where: { id: ctx.job.id },
      data: {
        status,
        state: toJson({ ...ctx.state, currentAccountId: null }),
        finishedAt: now,
        claimedBy: null,
        lockedAt: null,
        nextRunAt: null,
      },
    });
    await emitWsEvent(tx, "job", {
      jobId: ctx.job.id,
      groupId: ctx.groupId,
      kind: ctx.job.kind,
      status,
      step: ctx.job.step,
    });
    return status;
  });
  deps.log?.info(
    { jobId: ctx.job.id, groupId: ctx.groupId, status },
    "job 已结束",
  );
  return { kind: "done", status };
}

/** 记一条 errors 后直接收尾（不可恢复的情况） */
async function failWithError(
  job: Job,
  deps: JobServiceDeps,
  error: {
    step: JobStepKind;
    accountId: string | null;
    code: string;
    message: string;
  },
): Promise<StepOutcome> {
  await getDb().jobError.create({ data: { jobId: job.id, ...error } });
  const ctx: StepCtx = {
    job,
    groupId: job.groupId ?? "",
    input: { creatorAccountId: "", memberAccountIds: [] },
    state: safeState(job),
    deps,
  };
  return finish(ctx);
}

function safeState(job: Job): CreateGroupState {
  const parsed = createGroupStateSchema.safeParse(job.state);
  return parsed.success
    ? parsed.data
    : initialCreateGroupState({ creatorAccountId: "", memberAccountIds: [] });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 网关不可用 / 5xx / 结果不明：有界退避重试（这几步都可安全重做，见文件头）；超过上限记当前步
 * GATEWAY_UNAVAILABLE —— join 步只记该成员并继续，其他步收尾。
 */
async function onGatewayError(
  ctx: StepCtx,
  err: unknown,
  at: { step: JobStepKind; accountId: string | null },
): Promise<StepOutcome> {
  const { deps, state } = ctx;
  if (
    !(err instanceof GatewayUnreachableError) &&
    !(err instanceof GatewayResponseError && err.status >= 500)
  ) {
    // 没预料到的 4xx：不重试
    const code =
      err instanceof GatewayResponseError ? err.code : JOB_ERROR_CODES.internal;
    return at.accountId !== null
      ? memberFailed(ctx, at.accountId, code, describe(err))
      : failWithError(ctx.job, deps, { ...at, code, message: describe(err) });
  }
  const failures = state.transientFailures + 1;
  if (failures > TRANSIENT_MAX_FAILURES) {
    const message = `网关连续 ${state.transientFailures} 次不可用：${describe(err)}`;
    return at.accountId !== null
      ? memberFailed(
          ctx,
          at.accountId,
          JOB_ERROR_CODES.gatewayUnavailable,
          message,
        )
      : failWithError(ctx.job, deps, {
          ...at,
          code: JOB_ERROR_CODES.gatewayUnavailable,
          message,
        });
  }
  const now = deps.clock.now();
  const delay = Math.min(
    TRANSIENT_BASE_MS * 2 ** state.transientFailures,
    TRANSIENT_CAP_MS,
  );
  await persist(ctx, {
    state: { ...state, transientFailures: failures },
    lastError: describe(err),
  });
  deps.log?.warn(
    {
      err,
      jobId: ctx.job.id,
      step: at.step,
      accountId: at.accountId,
      failures,
      delay,
    },
    "网关不可用，退避后重试",
  );
  return { kind: "wait", until: new Date(now.getTime() + delay) };
}

async function requireGatewayGroupId(ctx: StepCtx): Promise<string> {
  const group = await getDb().group.findUniqueOrThrow({
    where: { id: ctx.groupId },
    select: { gatewayGroupId: true },
  });
  if (group.gatewayGroupId === null) {
    throw new Error(
      `群 ${ctx.groupId} 还没有 gatewayGroupId，却已在 ${ctx.job.step} 步`,
    );
  }
  return group.gatewayGroupId;
}
