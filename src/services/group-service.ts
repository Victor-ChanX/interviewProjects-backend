// 群（题目 2.3 groups 端点；status：active | unreachable | left）。两部分：
//
// 1. #7：网关回 GROUP_WRITE_FORBIDDEN（同步错误或 message_failed）时把群标成 unreachable 并级联（题目 A2 错误表）。
// 2. #11：群的读写 API —— createGroupJob（POST /api/groups：校验 + 一个事务里落 groups 行与 create_group job，
//    202 只保证「记录已落库」，网关调用全在 src/services/group-job-service.ts 的状态机里由 job worker 做）、
//    listGroups / getGroup（题目形状，members 从 group_members 读，activeSequenceRunId / activeAgentRunId
//    查 running 的运行）、patchGroup（开关，同事务写 ws_events group_settings_changed）、getJob（题目形状，
//    errors[].step 由 (stepKind, accountId) 拼回 `join:<accountId>`）。
// 3. #16：createLeaveAllJob（POST /api/groups/:id/leave-all：校验 + 落一条 leave_all job，202；退群全在
//    group-job-service 的状态机里由同一个 job worker 做）。
//
// 数据范围：只有 admin / viewer 两种角色，登录用户都可看全部群，没有归属键；群 / job 不存在 → 404。
//
// 「群不可写」级联的细则：
// 级联与状态写入同一事务，要么都生效、要么都不生效：
// - groups.status active → unreachable（已经不是 active 的群：no-op，返回 changed = false，不重复级联）；
// - 该群 running 的 sequence_runs → stopped（finishedAt = now），每条写一行 ws_events sequence_run；
// - 该群 queued 的出站消息 → cancelled（failCode = GROUP_UNREACHABLE）：不可写的群再往网关发只会一条条
//   403 回来；在途（claimed / accepted / unknown）的不动，由出站 worker 按网关的真实结果记账；
// - running 的 agent_runs：agent_runs 没有「请求取消」列，这里不改它的状态（A2 要求「当前步后 cancelled」，
//   由 agent 循环 #12 在每步之后读 groups.status 决定），只写一行 ws_events group_status_changed 让操作员看见。
//   计数 agentRunsRunning 返回给调用方（api.side-effect-count）。
// - 账号状态不变（题目原文）。
import type { Clock } from "../core/clock.js";
import { Conflict, Invalid, NotFound } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import {
  type Group,
  type GroupMember,
  type JobError,
  type JobStepKind,
  Prisma,
} from "../db/generated/client.js";
import type { GroupRead } from "../schemas/group.js";
import type { JobRead } from "../schemas/job.js";
import {
  type CreateGroupJobInput,
  initialCreateGroupState,
  initialLeaveAllState,
} from "./group-job-service.js";
import { emitWsEvent } from "./ws-events.js";

/** 群不可写时给被取消的出站消息打的码（题目 2.3 messages 的 failCode 取值之一）。 */
export const GROUP_UNREACHABLE_FAIL_CODE = "GROUP_UNREACHABLE";

export type GroupServiceDeps = {
  clock?: Clock;
  /** 路由传 request.log；worker 传 logger.child({ runId }) */
  log?: Pick<Logger, "info" | "warn" | "error">;
};

export type MarkUnreachableResult = {
  /** false = 群已不是 active（已 unreachable / left），什么都没改 */
  changed: boolean;
  sequenceRunsStopped: number;
  messagesCancelled: number;
  /** 仍在 running 的 agent run 数：由 #12 的循环在当前步后自行 cancelled */
  agentRunsRunning: number;
};

/** markGroupUnreachableInTx 的业务日志：调用方在 commit 之后调。 */
export function logGroupUnreachable(
  groupId: string,
  reason: string,
  result: MarkUnreachableResult,
  log: GroupServiceDeps["log"],
): void {
  if (result.changed) {
    log?.warn({ groupId, reason, ...result }, "群已标为 unreachable");
  }
}

/**
 * 网关说该群不可写（GROUP_WRITE_FORBIDDEN）：群 → unreachable + 级联（序列运行 stopped、未领取的 queued 消息
 * cancelled、事件）。在调用方的事务里跑 —— 群不可写与调用方自己的记账（出站派发的那条 failed、message_failed
 * 事件的 processedAt）同生共死；commit 之后调用方调 logGroupUnreachable。先改群行（行锁）再碰消息行。
 * reason 只进日志与事件 payload（同步错误 / message_failed 两个来源结果一样）。
 */
export async function markGroupUnreachableInTx(
  tx: Prisma.TransactionClient,
  groupId: string,
  reason: string,
  now: Date,
): Promise<MarkUnreachableResult> {
  const flipped = await tx.group.updateMany({
    where: { id: groupId, status: "active" },
    data: { status: "unreachable" },
  });
  if (flipped.count === 0) {
    return {
      changed: false,
      sequenceRunsStopped: 0,
      messagesCancelled: 0,
      agentRunsRunning: 0,
    } satisfies MarkUnreachableResult;
  }

  const runs = await tx.sequenceRun.findMany({
    where: { groupId, status: "running" },
    select: { id: true, currentStepIndex: true },
  });
  if (runs.length > 0) {
    await tx.sequenceRun.updateMany({
      where: { id: { in: runs.map((r) => r.id) } },
      data: { status: "stopped", finishedAt: now },
    });
    for (const run of runs) {
      await emitWsEvent(tx, "sequence_run", {
        runId: run.id,
        groupId,
        status: "stopped",
        currentStepIndex: run.currentStepIndex,
      });
    }
  }

  const queued = await tx.message.findMany({
    where: { groupId, deliveryStatus: "queued", claimedBy: null },
    select: { id: true, clientMsgId: true },
  });
  if (queued.length > 0) {
    await tx.message.updateMany({
      where: { id: { in: queued.map((m) => m.id) } },
      data: {
        deliveryStatus: "cancelled",
        failCode: GROUP_UNREACHABLE_FAIL_CODE,
      },
    });
    for (const m of queued) {
      await emitWsEvent(tx, "message", {
        groupId,
        msgId: null,
        clientMsgId: m.clientMsgId,
        isOwn: true,
        deliveryStatus: "cancelled",
        failCode: GROUP_UNREACHABLE_FAIL_CODE,
      });
    }
  }

  const agentRunsRunning = await tx.agentRun.count({
    where: { groupId, status: "running" },
  });

  await emitWsEvent(tx, "group_status_changed", {
    groupId,
    from: "active",
    to: "unreachable",
    reason,
  });

  return {
    changed: true,
    sequenceRunsStopped: runs.length,
    messagesCancelled: queued.length,
    agentRunsRunning,
  } satisfies MarkUnreachableResult;
}

// ============================================================================
// #11：群的读写 API
// ============================================================================

export type CreateGroupJobResult = { jobId: string; groupId: string };

/**
 * POST /api/groups（题目 2.3 + A3）：校验后在**一个事务**里落 groups 行（active、开关默认 false、
 * gatewayGroupId 先空）+ jobs 行（create_group、running、step = create、input 记账号），返回 jobId。
 * 不在这里调网关：202 只保证记录已落库，网关建群 / 邀请 / join / promote 全部由 job worker 按
 * src/services/group-job-service.ts 的状态机做，任一步崩溃重启后从该步继续。
 *
 * 校验（形状层的「≥ 1 个、不含群主、不重复」由 zod 拦成 400，见 src/schemas/group.ts）：
 * - 所有账号（含群主）都必须存在且 online → 否则 422 ACCOUNT_NOT_ONLINE，extra.accountIds 列出不合格的
 *   （不存在的账号也算：换一批账号就能过，是 422 不是 404）。
 */
export async function createGroupJob(
  input: CreateGroupJobInput,
  deps: GroupServiceDeps = {},
): Promise<CreateGroupJobResult> {
  const allIds = [input.creatorAccountId, ...input.memberAccountIds];
  const accounts = await getDb().account.findMany({
    where: { id: { in: allIds } },
    select: { id: true, status: true },
  });
  const online = new Set(
    accounts.filter((a) => a.status === "online").map((a) => a.id),
  );
  const offline = allIds.filter((id) => !online.has(id));
  if (offline.length > 0) {
    throw new Invalid(
      "ACCOUNT_NOT_ONLINE",
      `建群涉及的账号必须都是 online：${offline.join("、")} 不满足（不存在或不在线）`,
      { accountIds: offline },
    );
  }

  const result = await getDb().$transaction(async (tx) => {
    const group = await tx.group.create({
      data: {
        creatorAccountId: input.creatorAccountId,
        status: "active",
        agentEnabled: false,
        autoKickEnabled: false,
      },
      select: { id: true },
    });
    const job = await tx.job.create({
      data: {
        kind: "create_group",
        status: "running",
        groupId: group.id,
        step: "create",
        input: {
          creatorAccountId: input.creatorAccountId,
          memberAccountIds: input.memberAccountIds,
        },
        state: initialCreateGroupState(input),
        // null = 立刻可领（不写请求侧的时钟：worker 按自己的 clock 比较 nextRunAt）
        nextRunAt: null,
      },
      select: { id: true },
    });
    await emitWsEvent(tx, "job", {
      jobId: job.id,
      groupId: group.id,
      kind: "create_group",
      status: "running",
      step: "create",
    });
    return { jobId: job.id, groupId: group.id };
  });
  deps.log?.info(
    { ...result, creatorAccountId: input.creatorAccountId },
    "建群 job 已创建",
  );
  return result;
}

// ---- leave-all（#16）-----------------------------------------------------------------

export type CreateLeaveAllJobResult = { jobId: string; groupId: string };

/**
 * POST /api/groups/:id/leave-all（题目 2.3 + B2）：落一条 leave_all job（running、step = leave），返回 jobId；
 * 退群顺序（非群主先、群主最后）、失败处理、群 → left 与成员清理全在 src/services/group-job-service.ts 的
 * 状态机里，202 只保证记录已落库。
 *
 * 允许的群状态：active 与 unreachable（题目没限制；unreachable 只是「不可写消息」，退群仍有意义 ——
 * 这正是操作员想把账号从坏群里撤出来的时候）。拒绝：
 * - 群不存在 → 404 GROUP_NOT_FOUND；
 * - 已是 left → 409 GROUP_ALREADY_LEFT（成员早已清空，没有可退的；等状态变不了，请求本身没错，所以是 409 不是 422）；
 * - gatewayGroupId 为空（建群 job 的 create 步还没做完或已失败）→ 409 GROUP_NOT_READY；
 * - 该群已有 running 的 job（建群还在跑 / 另一个 leave-all 在跑）→ 409 JOB_ALREADY_RUNNING：靠部分唯一索引
 *   jobs_one_running_per_group 撞 P2002，不靠先查后插（两个请求同时查都查不到）。撞在事务里等于整个事务作废，
 *   这里正是要作废（不在同一事务里改走别的路，见 background-workers 的已知陷阱）。
 *
 * 要退的非群主账号在这里快照进 state / input：成员表里 accountId 非空（服务账号；外部用户没法替他们退）
 * 且 role ≠ creator，按入群顺序。
 */
export async function createLeaveAllJob(
  groupId: string,
  deps: GroupServiceDeps = {},
): Promise<CreateLeaveAllJobResult> {
  const result = await getDb().$transaction(async (tx) => {
    const group = await tx.group.findUnique({
      where: { id: groupId },
      include: membersInclude(),
    });
    if (!group) throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除");
    if (group.status === "left") {
      throw new Conflict(
        "GROUP_ALREADY_LEFT",
        "该群的服务账号已全部退出，不能再退",
      );
    }
    if (group.gatewayGroupId === null) {
      throw new Conflict(
        "GROUP_NOT_READY",
        "该群在网关里还没建成（建群任务未完成或已失败），没有可退的群",
      );
    }
    const input: CreateGroupJobInput = {
      creatorAccountId: group.creatorAccountId,
      memberAccountIds: group.members.flatMap((m) =>
        m.accountId !== null && m.role !== "creator" ? [m.accountId] : [],
      ),
    };
    let job: { id: string };
    try {
      job = await tx.job.create({
        data: {
          kind: "leave_all",
          status: "running",
          groupId: group.id,
          step: "leave",
          input,
          state: initialLeaveAllState(input),
          nextRunAt: null,
        },
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new Conflict(
          "JOB_ALREADY_RUNNING",
          "该群已有正在执行的任务（建群或退群），等它结束后再试",
        );
      }
      throw err;
    }
    await emitWsEvent(tx, "job", {
      jobId: job.id,
      groupId: group.id,
      kind: "leave_all",
      status: "running",
      step: "leave",
    });
    return {
      jobId: job.id,
      groupId: group.id,
      members: input.memberAccountIds,
    };
  });
  deps.log?.info(
    { jobId: result.jobId, groupId, memberAccountIds: result.members },
    "leave-all job 已创建",
  );
  return { jobId: result.jobId, groupId: result.groupId };
}

// ---- 读 --------------------------------------------------------------------------

type GroupWithMembers = Group & { members: GroupMember[] };

/** 题目 2.3 形状；activeSequenceRunId / activeAgentRunId 从传入的 running 集合里取。 */
function toGroupRead(
  row: GroupWithMembers,
  running: { sequenceRunId: string | null; agentRunId: string | null },
): GroupRead {
  return {
    id: row.id,
    gatewayGroupId: row.gatewayGroupId,
    status: row.status,
    creatorAccountId: row.creatorAccountId,
    agentEnabled: row.agentEnabled,
    autoKickEnabled: row.autoKickEnabled,
    members: row.members.map((m) => ({
      accountId: m.accountId,
      platformUserId: m.platformUserId,
      role: m.role,
    })),
    activeSequenceRunId: running.sequenceRunId,
    activeAgentRunId: running.agentRunId,
  };
}

/** 一批群各自 running 的运行 id（同群至多一个 running，由部分唯一索引保证）。 */
async function runningRunsByGroup(
  groupIds: string[],
): Promise<
  Map<string, { sequenceRunId: string | null; agentRunId: string | null }>
> {
  const map = new Map<
    string,
    { sequenceRunId: string | null; agentRunId: string | null }
  >();
  for (const id of groupIds)
    map.set(id, { sequenceRunId: null, agentRunId: null });
  if (groupIds.length === 0) return map;
  const db = getDb();
  const [sequenceRuns, agentRuns] = await Promise.all([
    db.sequenceRun.findMany({
      where: { groupId: { in: groupIds }, status: "running" },
      select: { id: true, groupId: true },
    }),
    db.agentRun.findMany({
      where: { groupId: { in: groupIds }, status: "running" },
      select: { id: true, groupId: true },
    }),
  ]);
  for (const r of sequenceRuns) map.get(r.groupId)!.sequenceRunId = r.id;
  for (const r of agentRuns) map.get(r.groupId)!.agentRunId = r.id;
  return map;
}

/** 成员按入群顺序（只读配置，不是状态） */
function membersInclude() {
  return {
    members: { orderBy: [{ joinedAt: "asc" }, { platformUserId: "asc" }] },
  } satisfies Prisma.GroupInclude;
}

/** GET /api/groups：全部群（题目形状的裸数组），按创建顺序。 */
export async function listGroups(): Promise<GroupRead[]> {
  const rows = await getDb().group.findMany({
    include: membersInclude(),
    orderBy: { createdAt: "asc" },
  });
  const running = await runningRunsByGroup(rows.map((r) => r.id));
  return rows.map((r) => toGroupRead(r, running.get(r.id)!));
}

/** GET /api/groups/:id；不存在 → 404 GROUP_NOT_FOUND。 */
export async function getGroup(groupId: string): Promise<GroupRead> {
  const row = await getDb().group.findUnique({
    where: { id: groupId },
    include: membersInclude(),
  });
  if (!row) throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除");
  const running = await runningRunsByGroup([row.id]);
  return toGroupRead(row, running.get(row.id)!);
}

export type PatchGroupInput = {
  agentEnabled?: boolean;
  autoKickEnabled?: boolean;
};

/**
 * PATCH /api/groups/:id { agentEnabled?, autoKickEnabled? }：只改传了的开关；有变化时同事务写一行
 * ws_events group_settings_changed（agent 循环 #12 / 自动踢人按它感知开关）。不存在 → 404。
 */
export async function patchGroup(
  groupId: string,
  patch: PatchGroupInput,
  deps: GroupServiceDeps = {},
): Promise<GroupRead> {
  const changed = await getDb().$transaction(async (tx) => {
    const current = await tx.group.findUnique({
      where: { id: groupId },
      select: { agentEnabled: true, autoKickEnabled: true },
    });
    if (!current) throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除");
    const next = {
      agentEnabled: patch.agentEnabled ?? current.agentEnabled,
      autoKickEnabled: patch.autoKickEnabled ?? current.autoKickEnabled,
    };
    if (
      next.agentEnabled === current.agentEnabled &&
      next.autoKickEnabled === current.autoKickEnabled
    ) {
      return false;
    }
    await tx.group.update({ where: { id: groupId }, data: next });
    await emitWsEvent(tx, "group_settings_changed", { groupId, ...next });
    return true;
  });
  if (changed) deps.log?.info({ groupId, ...patch }, "群开关已更新");
  return getGroup(groupId);
}

// ---- job 读 ----------------------------------------------------------------------

/** 题目 2.3 的 step 字符串：`create | invite | join:<accountId> | promote | leave:<accountId>` */
export function formatJobStep(
  stepKind: JobStepKind,
  accountId: string | null,
): string {
  return accountId === null ? stepKind : `${stepKind}:${accountId}`;
}

function toJobErrorRead(e: JobError): JobRead["errors"][number] {
  return {
    step: formatJobStep(e.step, e.accountId),
    stepKind: e.step,
    accountId: e.accountId,
    code: e.code,
    message: e.message,
  };
}

/** GET /api/jobs/:jobId；不存在 → 404 JOB_NOT_FOUND。errors 按记录顺序。 */
export async function getJob(jobId: string): Promise<JobRead> {
  const row = await getDb().job.findUnique({
    where: { id: jobId },
    include: { errors: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  if (!row) throw new NotFound("JOB_NOT_FOUND", "任务不存在");
  // 当前步的账号（join:<accountId>）在 state 里；终态后 step 保留最后一步
  const state = row.state as { currentAccountId?: unknown } | null;
  const currentAccountId =
    typeof state?.currentAccountId === "string" ? state.currentAccountId : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    groupId: row.groupId,
    step:
      row.step === null
        ? null
        : formatJobStep(
            row.step,
            row.step === "join" || row.step === "leave"
              ? currentAccountId
              : null,
          ),
    errors: row.errors.map(toJobErrorRead),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
