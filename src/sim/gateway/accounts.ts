// 账号：connect / disconnect、平台停用与会话失效、限流。
//
// 账号不需要预置：任何 accountId 第一次出现即登记（题目里账号在应用侧 seed）。platformUserId 由
// accountId 哈希得出，所以同一个 accountId 每次 connect、甚至模拟器重启后都拿到同一个值。
// suspended / session_expired 是终态：之后该账号的所有请求（含 connect）都得到同样的错误，
// 并被移出所有群、每个群推一条 member_left（题目 2.1「账号」一节）。
import { createHash } from "node:crypto";

import { GatewayError } from "./errors.js";
import { emit } from "./events.js";
import { type Account, type GatewayContext, nowMs } from "./state.js";

export function platformUserIdFor(accountId: string): string {
  return `pu_${createHash("sha256").update(accountId).digest("hex").slice(0, 12)}`;
}

export function getOrCreateAccount(
  ctx: GatewayContext,
  accountId: string,
): Account {
  let account = ctx.accounts.get(accountId);
  if (!account) {
    account = {
      accountId,
      platformUserId: platformUserIdFor(accountId),
      online: false,
      status: "active",
      rateLimitedUntil: null,
      rateLimitRetryAfterSeconds: null,
    };
    ctx.accounts.set(accountId, account);
  }
  return account;
}

/** 终态账号的任何请求都拒绝：403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED。 */
export function assertUsable(ctx: GatewayContext, accountId: string): Account {
  const account = getOrCreateAccount(ctx, accountId);
  if (account.status === "suspended") {
    throw new GatewayError(
      403,
      "ACCOUNT_SUSPENDED",
      `账号 ${accountId} 已被平台停用`,
    );
  }
  if (account.status === "session_expired") {
    throw new GatewayError(
      401,
      "SESSION_EXPIRED",
      `账号 ${accountId} 的会话已失效`,
    );
  }
  return account;
}

/** send / join / promote / kick / leave 要求在线：否则 409 ACCOUNT_OFFLINE。 */
export function assertOnline(ctx: GatewayContext, accountId: string): Account {
  const account = assertUsable(ctx, accountId);
  if (!account.online) {
    throw new GatewayError(
      409,
      "ACCOUNT_OFFLINE",
      `账号 ${accountId} 未 connect 或已 disconnect`,
    );
  }
  return account;
}

export function connect(
  ctx: GatewayContext,
  accountId: string,
): { platformUserId: string } {
  const account = assertUsable(ctx, accountId);
  account.online = true;
  return { platformUserId: account.platformUserId };
}

export function disconnect(ctx: GatewayContext, accountId: string): void {
  const account = assertUsable(ctx, accountId);
  account.online = false;
}

/**
 * 账号进入 suspended / session_expired：标状态、移出所有群（每群一条 member_left）、
 * 可选再推一条 account_status（题目：网关「可能（不保证）」推）。已在终态的账号不重复处理。
 */
export function setTerminalStatus(
  ctx: GatewayContext,
  accountId: string,
  status: "suspended" | "session_expired",
  opts: { pushEvent: boolean },
): void {
  const account = getOrCreateAccount(ctx, accountId);
  if (account.status !== "active") return;
  account.status = status;
  account.online = false;
  if (opts.pushEvent) emit(ctx, "account_status", { accountId, status });
  for (const group of ctx.groups.values()) {
    group.pendingJoins.delete(account.platformUserId);
    if (!group.members.delete(account.platformUserId)) continue;
    if (group.ownerPlatformUserId === account.platformUserId) {
      group.ownerLeft = true;
    }
    emit(ctx, "member_left", {
      groupId: group.groupId,
      platformUserId: account.platformUserId,
    });
  }
}

/** 进入 / 重置限流期：截止 = 现在 + retryAfterSeconds。 */
export function rateLimit(
  ctx: GatewayContext,
  account: Account,
  retryAfterSeconds: number,
): GatewayError {
  account.rateLimitedUntil = nowMs(ctx) + retryAfterSeconds * 1000;
  account.rateLimitRetryAfterSeconds = retryAfterSeconds;
  return new GatewayError(
    429,
    "RATE_LIMITED",
    `账号 ${account.accountId} 被限流，${retryAfterSeconds} 秒后再试`,
    { retryAfterSeconds },
  );
}

/** 限流期内的 send：再次 429（同样的 retryAfterSeconds）并把计时重置。 */
export function assertNotRateLimited(
  ctx: GatewayContext,
  account: Account,
): void {
  if (account.rateLimitedUntil === null) return;
  if (nowMs(ctx) >= account.rateLimitedUntil) {
    account.rateLimitedUntil = null;
    account.rateLimitRetryAfterSeconds = null;
    return;
  }
  throw rateLimit(ctx, account, account.rateLimitRetryAfterSeconds ?? 1);
}
