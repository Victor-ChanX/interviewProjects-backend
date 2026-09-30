// 账号状态机（题目 A1 + 2.3 的 accounts 端点，issue #6）。
//
// 三条硬规则，全部落在 transition() 一个函数、一个 $transaction 里：
// 1. 转移表 TRANSITIONS 是唯一的合法性来源：表外（含同状态到同状态）→ 409 ILLEGAL_TRANSITION。
// 2. CAS：调用方声明 expectedFrom；当前状态不是它 → 409 CAS_CONFLICT。写入用 `updateMany where { id, version }`
//    （accounts.version 每次写 +1），并发两次改同一账号时后提交的那次 count = 0 → CAS_CONFLICT，不能后写覆盖先写。
// 3. 终态级联（suspended / session_expired）与状态写入同一事务：移出所有群成员行、排队中的出站消息 → cancelled
//    （failCode = ACCOUNT_TERMINAL）、对应序列步骤 → skipped、写 account_terminal 事件。要么都生效，要么都不生效。
//    无论来源是操作员、网关事件还是发送错误（TransitionSource），都走这一个函数，结果一样。
//    重复进入同一终态静默忽略：返回当前状态，不报错、不再级联、不再发事件。
//
// 每次成功转移在同一事务里写一行 ws_events（account_status_changed { accountId, from, to }）：
// 推给前端的状态事件必须对应已经保存的状态 —— 事务回滚事件就一起没了。WS 推送本身是 #9，这里只落表。
//
// 外部副作用不在事务里：标 idle / disconnected 时的网关 disconnect 在 commit 之后调，失败只记日志
// （本地状态是真相：账号已被本地标离线，出站 worker 不会再用它发消息；网关侧多挂一会儿没有后果）。
import { type Clock, systemClock } from "../core/clock.js";
import { BadGateway, Conflict, DomainError, NotFound } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type { Account, AccountStatus, Prisma } from "../db/generated/client.js";
import type { AccountRead } from "../schemas/account.js";
import {
  type GatewayClient,
  GatewayResponseError,
  GatewayUnreachableError,
} from "./gateway-client.js";

// ---- 转移表（题目 A1：行 = 当前状态，列 = 目标状态）----------------------------------

export const TRANSITIONS: Readonly<
  Record<AccountStatus, readonly AccountStatus[]>
> = Object.freeze({
  idle: ["online", "suspended", "session_expired"],
  online: [
    "idle",
    "rate_limited",
    "disconnected",
    "suspended",
    "session_expired",
  ],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  // 终态没有出边，重连也不能恢复
  suspended: [],
  session_expired: [],
});

export const TERMINAL_STATUSES = ["suspended", "session_expired"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: AccountStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly AccountStatus[]).includes(status);
}

/** 同状态到同状态也不在表上（TRANSITIONS 里没有自环），一律非法。 */
export function canTransition(from: AccountStatus, to: AccountStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 标 idle / disconnected = 本地把账号下线，要同步让网关断开。 */
const OFFLINE_TARGETS: readonly AccountStatus[] = Object.freeze([
  "idle",
  "disconnected",
]);

/** 默认的操作员手动标 rate_limited 的限流时长（网关 429 时用它的 retryAfterSeconds，不用这个）。 */
export const DEFAULT_RATE_LIMIT_SECONDS = 60;

/** 进终态时给被取消的出站消息 / 被跳过的序列步骤打的码（题目 2.3 messages 的 failCode 取值之一）。 */
export const ACCOUNT_TERMINAL_FAIL_CODE = "ACCOUNT_TERMINAL";

// ---- 类型 ------------------------------------------------------------------------

/** 谁触发的转移：只用于日志 / 排障，不影响结果（三种来源结果一致是 A1 的要求）。 */
export type TransitionSource =
  | "operator"
  | "gateway_event"
  | "send_error"
  | "connect_error"
  | "rate_limit_worker";

export type TransitionInput = {
  to: AccountStatus;
  expectedFrom: AccountStatus;
  source: TransitionSource;
  /** to = rate_limited 时必填：限流秒数，到期时刻 = clock.now() + 它（库里 CHECK：rate_limited 必须带到期时刻） */
  rateLimitSeconds?: number;
  /** connect 成功后写入网关给的 platformUserId */
  platformUserId?: string;
  /**
   * 额外的乐观锁前提：给「先读后判再转移」的调用方（限流恢复 worker）用 —— 读到的行在判断与转移之间
   * 被别人改过（哪怕状态没变，例如 rateLimitedUntil 被刷新）就 CAS_CONFLICT，不做转移。
   */
  expectedVersion?: number;
};

export type TransitionDeps = {
  clock?: Clock;
  /** 路由传 request.log（带 requestId）；worker 传 logger.child({ runId }) */
  log?: Pick<Logger, "info" | "warn" | "error">;
  /** 给了才会在标 idle / disconnected 后调网关 disconnect */
  gateway?: GatewayClient;
};

export type CascadeCounts = {
  membersRemoved: number;
  messagesCancelled: number;
  stepsSkipped: number;
};

export type TransitionResult = {
  account: Account;
  from: AccountStatus;
  /** false = 重复进入同一终态被静默忽略 */
  changed: boolean;
  cascade: CascadeCounts;
};

const NO_CASCADE: Readonly<CascadeCounts> = Object.freeze({
  membersRemoved: 0,
  messagesCancelled: 0,
  stepsSkipped: 0,
});

// ---- 读 ---------------------------------------------------------------------------

export function toAccountRead(row: Account): AccountRead {
  return {
    id: row.id,
    status: row.status,
    platformUserId: row.platformUserId,
    rateLimitedUntil: row.rateLimitedUntil?.toISOString() ?? null,
  };
}

export async function listAccounts(): Promise<AccountRead[]> {
  const rows = await getDb().account.findMany({ orderBy: { id: "asc" } });
  return rows.map(toAccountRead);
}

async function findAccountOrThrow(
  db: Prisma.TransactionClient | ReturnType<typeof getDb>,
  accountId: string,
): Promise<Account> {
  const row = await db.account.findUnique({ where: { id: accountId } });
  if (!row) {
    throw new NotFound("ACCOUNT_NOT_FOUND", `账号 ${accountId} 不存在`, {
      accountId,
    });
  }
  return row;
}

// ---- 转移 -------------------------------------------------------------------------

export async function transition(
  accountId: string,
  input: TransitionInput,
  deps: TransitionDeps = {},
): Promise<TransitionResult> {
  const clock = deps.clock ?? systemClock;
  const db = getDb();

  const result = await db.$transaction(async (tx) => {
    const row = await findAccountOrThrow(tx, accountId);

    // 重复进入同一终态：静默忽略（不看 expectedFrom —— 网关事件 / 发送错误 / 操作员各自读到的
    // 旧状态可能不同，但目的都已达成；再判 CAS 只会让后到的来源无谓报错）。
    if (isTerminal(input.to) && row.status === input.to) {
      return {
        account: row,
        from: row.status,
        changed: false,
        cascade: NO_CASCADE,
      } satisfies TransitionResult;
    }

    if (!canTransition(input.expectedFrom, input.to)) {
      throw new Conflict(
        "ILLEGAL_TRANSITION",
        `账号不能从 ${input.expectedFrom} 转到 ${input.to}`,
        { accountId, from: input.expectedFrom, to: input.to },
      );
    }
    if (row.status !== input.expectedFrom) {
      throw casConflict(accountId, input.expectedFrom, row.status);
    }
    if (
      input.expectedVersion !== undefined &&
      row.version !== input.expectedVersion
    ) {
      throw casConflict(accountId, input.expectedFrom, row.status);
    }
    if (input.to === "rate_limited" && input.rateLimitSeconds === undefined) {
      throw new Error("transition 到 rate_limited 必须给 rateLimitSeconds");
    }
    const now = clock.now();

    // CAS 写入：where 带 version，并发下只有一个 count = 1。
    const written = await tx.account.updateMany({
      where: { id: accountId, version: row.version },
      data: {
        status: input.to,
        version: { increment: 1 },
        rateLimitedUntil:
          input.to === "rate_limited"
            ? new Date(now.getTime() + (input.rateLimitSeconds ?? 0) * 1000)
            : null,
        ...(input.platformUserId !== undefined
          ? { platformUserId: input.platformUserId }
          : {}),
      },
    });
    if (written.count === 0) {
      throw casConflict(accountId, input.expectedFrom, row.status);
    }

    const cascade = isTerminal(input.to)
      ? await cascadeTerminal(tx, accountId, now)
      : NO_CASCADE;

    await tx.wsEvent.create({
      data: {
        type: "account_status_changed",
        payload: { accountId, from: row.status, to: input.to },
      },
    });
    if (isTerminal(input.to)) {
      await tx.wsEvent.create({
        data: {
          type: "account_terminal",
          payload: { accountId, status: input.to },
        },
      });
    }

    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    return {
      account,
      from: row.status,
      changed: true,
      cascade,
    } satisfies TransitionResult;
  });

  // commit 之后才记业务日志 / 做外部副作用
  if (result.changed) {
    deps.log?.info(
      {
        accountId,
        from: result.from,
        to: input.to,
        source: input.source,
        ...result.cascade,
      },
      "账号状态已转移",
    );
    if (deps.gateway && OFFLINE_TARGETS.includes(input.to)) {
      try {
        await deps.gateway.disconnect(accountId);
      } catch (err) {
        // 本地已下线即生效；网关侧断不开只影响网关那边的在线标记，下次 connect 会覆盖。
        deps.log?.warn(
          { err, accountId, to: input.to },
          "网关 disconnect 失败，本地状态已生效",
        );
      }
    }
  } else {
    deps.log?.info(
      { accountId, status: input.to, source: input.source },
      "账号已在该终态，重复进入被忽略",
    );
  }
  return result;
}

function casConflict(
  accountId: string,
  expectedFrom: AccountStatus,
  current: AccountStatus,
): Conflict {
  return new Conflict(
    "CAS_CONFLICT",
    `账号当前状态是 ${current}，不是 ${expectedFrom}，请刷新后重试`,
    { accountId, expectedFrom, current },
  );
}

/**
 * 终态级联（与状态写入同一事务）：
 * - group_members 里该账号的成员行全部删除（网关那边也会把它移出所有群并推 member_left，事件到了是空操作）；
 * - 该账号 deliveryStatus = queued 的出站消息 → cancelled + failCode = ACCOUNT_TERMINAL。
 *   只取 queued：accepted 已被网关收下、unknown 还在按 by-client-id 确认（A2 要求 5 秒内落定），两者的
 *   终局由出站 worker 按网关的真实结果记账，这里改了反而会和 message_sent 打架；
 * - 这些消息对应的 sequence_run_steps（clientMsgId 指向它们）→ skipped。还没入队的 pending 步没有消息，
 *   由序列 worker 在选账号时自己看账号状态；
 * - 事件 account_terminal 由调用方（transition）写在同一事务里。
 */
async function cascadeTerminal(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
): Promise<CascadeCounts> {
  const members = await tx.groupMember.deleteMany({ where: { accountId } });

  const queued = await tx.message.findMany({
    where: { accountId, deliveryStatus: "queued" },
    select: { id: true, clientMsgId: true },
  });
  const messages =
    queued.length === 0
      ? { count: 0 }
      : await tx.message.updateMany({
          where: { id: { in: queued.map((m) => m.id) } },
          data: {
            deliveryStatus: "cancelled",
            failCode: ACCOUNT_TERMINAL_FAIL_CODE,
          },
        });

  const clientMsgIds = queued
    .map((m) => m.clientMsgId)
    .filter((id): id is string => id !== null);
  const steps =
    clientMsgIds.length === 0
      ? { count: 0 }
      : await tx.sequenceRunStep.updateMany({
          where: {
            clientMsgId: { in: clientMsgIds },
            status: { notIn: ["sent", "skipped", "failed"] },
          },
          data: {
            status: "skipped",
            skippedAt: now,
            failCode: ACCOUNT_TERMINAL_FAIL_CODE,
          },
        });

  return {
    membersRemoved: members.count,
    messagesCancelled: messages.count,
    stepsSkipped: steps.count,
  };
}

/** 读 → 按当前状态转移；撞 CAS_CONFLICT（别人刚改过）就重读再试，最多 attempts 次。 */
async function withCasRetry<T>(
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (
        i < attempts &&
        err instanceof DomainError &&
        err.code === "CAS_CONFLICT"
      ) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * 进终态的统一入口：网关事件（account_status）、发送错误（ACCOUNT_SUSPENDED / SESSION_EXPIRED）、
 * connect 被拒都从这里进 transition —— 它们没有「操作员看到的旧状态」，expectedFrom 取当前状态；
 * 已在该终态时 transition 静默返回 changed = false。
 */
export async function enterTerminal(
  accountId: string,
  status: TerminalStatus,
  source: Exclude<TransitionSource, "rate_limit_worker">,
  deps: TransitionDeps = {},
): Promise<TransitionResult> {
  return withCasRetry(3, async () => {
    const row = await findAccountOrThrow(getDb(), accountId);
    return transition(
      accountId,
      { to: status, expectedFrom: row.status, source },
      deps,
    );
  });
}

// ---- 限流 -------------------------------------------------------------------------

/**
 * 网关 429 RATE_LIMITED { retryAfterSeconds }：online → rate_limited，rateLimitedUntil = now + N 秒。
 * 已是 rate_limited 只刷新 until（题目 A1：刷新不算状态转移 —— 不发 account_status_changed；
 * version 仍 +1，让正在按旧 version 做 CAS 的转移知道行变过）。
 * 其他状态（idle / disconnected / 终态）收到 429 是不可能的组合，按转移表报 ILLEGAL_TRANSITION。
 */
export async function enterRateLimited(
  accountId: string,
  retryAfterSeconds: number,
  deps: TransitionDeps & { source?: TransitionSource } = {},
): Promise<TransitionResult> {
  const clock = deps.clock ?? systemClock;
  const db = getDb();
  return withCasRetry(3, async () => {
    const until = new Date(clock.now().getTime() + retryAfterSeconds * 1000);
    const row = await findAccountOrThrow(db, accountId);
    if (row.status === "rate_limited") {
      const refreshed = await db.account.updateMany({
        where: { id: accountId, version: row.version },
        data: { rateLimitedUntil: until, version: { increment: 1 } },
      });
      if (refreshed.count === 0) {
        throw casConflict(accountId, row.status, row.status);
      }
      const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      deps.log?.info(
        { accountId, rateLimitedUntil: until.toISOString() },
        "限流截止已刷新",
      );
      return {
        account,
        from: row.status,
        changed: false,
        cascade: NO_CASCADE,
      };
    }
    return transition(
      accountId,
      {
        to: "rate_limited",
        expectedFrom: row.status,
        source: deps.source ?? "send_error",
        rateLimitSeconds: retryAfterSeconds,
      },
      deps,
    );
  });
}

/**
 * 到期恢复（题目 A1）：rateLimitedUntil ≤ now 且仍是 rate_limited 的账号 → online。
 * 到期时已不是 rate_limited（例如已被操作员标离线）、或 until 在读与转移之间被刷新（version 变了）
 * 都不做转移 —— 靠 transition 的 expectedFrom + expectedVersion 双重 CAS，撞上就跳过，下个 tick 再看。
 * 由 src/workers/rate-limit-worker.ts 每 tick 调；#7 的出站 worker 也可以在 tick 里顺手调。
 */
export async function recoverRateLimited(
  deps: TransitionDeps = {},
): Promise<{ due: number; recovered: number }> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const due = await getDb().account.findMany({
    where: { status: "rate_limited", rateLimitedUntil: { lte: now } },
    select: { id: true, version: true },
    orderBy: { id: "asc" },
  });
  let recovered = 0;
  for (const { id, version } of due) {
    try {
      await transition(
        id,
        {
          to: "online",
          expectedFrom: "rate_limited",
          expectedVersion: version,
          source: "rate_limit_worker",
        },
        deps,
      );
      recovered += 1;
    } catch (err) {
      if (err instanceof DomainError && err.code === "CAS_CONFLICT") {
        deps.log?.info({ accountId: id }, "限流到期时账号已被改动，跳过恢复");
        continue;
      }
      throw err;
    }
  }
  return { due: due.length, recovered };
}

// ---- connect（题目 2.3）--------------------------------------------------------------

/**
 * POST /api/accounts/:id/connect：idle / disconnected → 调网关 connect → online + platformUserId。
 * - 终态账号：409 ACCOUNT_UNAVAILABLE（重连也不能恢复），不打网关；
 * - online / rate_limited：已经连着，409 ILLEGAL_TRANSITION；
 * - 网关回 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED：账号进相应终态（级联），再对外 409 ACCOUNT_UNAVAILABLE；
 * - 网关不可用（503 / 连不上 / 超时）：502 GATEWAY_ERROR，本地状态不变；
 * - 网关 connect 成功后本地 CAS 失败（期间被标了别的状态）：CAS_CONFLICT 原样抛出 —— 网关侧多了个在线标记，
 *   但本地是真相，账号不会被用来发消息。
 */
export async function connect(
  accountId: string,
  deps: TransitionDeps & { gateway: GatewayClient },
): Promise<TransitionResult> {
  const row = await findAccountOrThrow(getDb(), accountId);
  if (isTerminal(row.status)) {
    throw new Conflict(
      "ACCOUNT_UNAVAILABLE",
      `账号已${row.status === "suspended" ? "被平台停用" : "会话失效"}，不能再连接`,
      { accountId, status: row.status },
    );
  }
  if (row.status !== "idle" && row.status !== "disconnected") {
    throw new Conflict(
      "ILLEGAL_TRANSITION",
      `账号当前是 ${row.status}，只有 idle / disconnected 的账号可以 connect`,
      { accountId, from: row.status, to: "online" },
    );
  }

  let platformUserId: string;
  try {
    ({ platformUserId } = await deps.gateway.connect(accountId));
  } catch (err) {
    const terminal = terminalFromGatewayError(err);
    if (terminal) {
      await enterTerminal(accountId, terminal, "connect_error", deps);
      throw new Conflict(
        "ACCOUNT_UNAVAILABLE",
        `网关拒绝连接：账号已${terminal === "suspended" ? "被平台停用" : "会话失效"}`,
        { accountId, status: terminal },
      );
    }
    // 只翻译网关自己的错（回了非 2xx / 连不上）；别的异常（配置缺失、编程错误）原样抛成 500
    if (
      !(err instanceof GatewayResponseError) &&
      !(err instanceof GatewayUnreachableError)
    ) {
      throw err;
    }
    deps.log?.warn({ err, accountId }, "网关 connect 失败");
    throw new BadGateway("GATEWAY_ERROR", "消息网关暂时不可用，请稍后再试", {
      accountId,
      ...(err instanceof GatewayResponseError
        ? { gatewayStatus: err.status, gatewayCode: err.code }
        : {}),
    });
  }

  return transition(
    accountId,
    {
      to: "online",
      expectedFrom: row.status,
      source: "operator",
      platformUserId,
    },
    deps,
  );
}

/** 网关对账号请求回的两种「永久不可用」码 → 对应终态；其余返回 undefined。 */
export function terminalFromGatewayError(
  err: unknown,
): TerminalStatus | undefined {
  if (!(err instanceof GatewayResponseError)) return undefined;
  if (err.code === "ACCOUNT_SUSPENDED") return "suspended";
  if (err.code === "SESSION_EXPIRED") return "session_expired";
  return undefined;
}
