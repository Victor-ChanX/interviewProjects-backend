// 群与成员：建群 / 邀请链接 / join / promote / kick / leave / 成员列表。
//
// 题目 2.1「群与成员」逐条：创建者建群即为群主与成员（不推 member_joined）；邀请链接有 readyAfterMs
// 与过期（409 INVITE_NOT_READY / 410 INVITE_EXPIRED）；join 是 202 受理、入群以 member_joined 为准
// （可能永远不来）；已在群里再 join → 409 ALREADY_MEMBER；promote 只群主可做（403 NO_PERMISSION），
// 对方未入群 → 409 NOT_MEMBER_YET，不推事件；kick：目标在 200 前已从成员列表移除、随后推 member_left，
// 群主已退群 → 409 OWNER_LEFT，非群主且未 promote → 403 NO_PERMISSION，响应 1–5s 或 504；
// leave → 200 + member_left，或 500（没退成）。成员列表在事件推出之前就已变化。
//
// 题目没写、模拟器自定的码：404 GROUP_NOT_FOUND（群不存在）、409 NOT_IN_GROUP（kick 的目标 / leave 的
// 账号不在群里）。
import { randomBytes } from "node:crypto";

import { assertOnline, getOrCreateAccount } from "./accounts.js";
import { GatewayError } from "./errors.js";
import { emit } from "./events.js";
import { type GatewayContext, type Group, nowMs } from "./state.js";

export function getGroup(ctx: GatewayContext, groupId: string): Group {
  const group = ctx.groups.get(groupId);
  if (!group) {
    throw new GatewayError(404, "GROUP_NOT_FOUND", `群 ${groupId} 不存在`);
  }
  return group;
}

export function createGroup(
  ctx: GatewayContext,
  creatorAccountId: string,
): { groupId: string } {
  const creator = assertOnline(ctx, creatorAccountId);
  const groupId = `g_${randomBytes(6).toString("hex")}`;
  ctx.groups.set(groupId, {
    groupId,
    ownerAccountId: creatorAccountId,
    ownerPlatformUserId: creator.platformUserId,
    ownerLeft: false,
    writeForbidden: ctx.scenario.groups.writeForbidden.includes(groupId),
    members: new Map([
      [
        creator.platformUserId,
        { platformUserId: creator.platformUserId, isAdmin: true },
      ],
    ]),
    pendingJoins: new Set(),
  });
  return { groupId };
}

export function createInvite(
  ctx: GatewayContext,
  groupId: string,
): { inviteLink: string; readyAfterMs: number } {
  getGroup(ctx, groupId);
  const { readyAfterMs: range, expiresAfterMs } = ctx.scenario.invite;
  const readyAfterMs = ctx.rng.fromRange(range);
  const inviteLink = `inv_${randomBytes(8).toString("hex")}`;
  const now = nowMs(ctx);
  ctx.invites.set(inviteLink, {
    inviteLink,
    groupId,
    readyAt: now + readyAfterMs,
    expiresAt: expiresAfterMs === null ? null : now + expiresAfterMs,
  });
  return { inviteLink, readyAfterMs };
}

/** POST /_sim/invites/expire：让链接（或全部链接）立刻过期。返回受影响条数。 */
export function expireInvites(
  ctx: GatewayContext,
  inviteLink: string | undefined,
): number {
  const now = nowMs(ctx);
  let n = 0;
  for (const invite of ctx.invites.values()) {
    if (inviteLink !== undefined && invite.inviteLink !== inviteLink) continue;
    invite.expiresAt = now;
    n += 1;
  }
  return n;
}

export function join(
  ctx: GatewayContext,
  groupId: string,
  accountId: string,
  inviteLink: string,
): { accepted: true } {
  const account = assertOnline(ctx, accountId);
  const group = getGroup(ctx, groupId);
  if (group.members.has(account.platformUserId)) {
    throw new GatewayError(
      409,
      "ALREADY_MEMBER",
      `账号 ${accountId} 已经在群 ${groupId} 里`,
    );
  }
  const invite = ctx.invites.get(inviteLink);
  const now = nowMs(ctx);
  if (
    !invite ||
    invite.groupId !== groupId ||
    (invite.expiresAt !== null && now >= invite.expiresAt)
  ) {
    throw new GatewayError(
      410,
      "INVITE_EXPIRED",
      "邀请链接已过期或不存在，请重新申请一个",
    );
  }
  if (now < invite.readyAt) {
    throw new GatewayError(
      409,
      "INVITE_NOT_READY",
      `邀请链接 ${Math.max(0, invite.readyAt - now)} ms 后才可用`,
    );
  }

  const { neverJoin, delayMs } = ctx.scenario.join;
  if (!neverJoin && !group.pendingJoins.has(account.platformUserId)) {
    group.pendingJoins.add(account.platformUserId);
    ctx.timers.schedule(ctx.rng.fromRange(delayMs), () => {
      group.pendingJoins.delete(account.platformUserId);
      // 受理到入群之间账号可能已被停用（setTerminalStatus 会清 pendingJoins，这里再兜一次）。
      if (account.status !== "active") return;
      addMember(ctx, group, account.platformUserId);
    });
  }
  return { accepted: true };
}

/** 成员列表先变、事件后推（题目：列表变化在前，事件在后）。已是成员则什么都不做。 */
export function addMember(
  ctx: GatewayContext,
  group: Group,
  platformUserId: string,
): boolean {
  if (group.members.has(platformUserId)) return false;
  group.members.set(platformUserId, { platformUserId, isAdmin: false });
  emit(ctx, "member_joined", { groupId: group.groupId, platformUserId });
  return true;
}

export function removeMember(
  ctx: GatewayContext,
  group: Group,
  platformUserId: string,
): boolean {
  if (!group.members.delete(platformUserId)) return false;
  if (platformUserId === group.ownerPlatformUserId) group.ownerLeft = true;
  emit(ctx, "member_left", { groupId: group.groupId, platformUserId });
  return true;
}

export function promote(
  ctx: GatewayContext,
  groupId: string,
  byAccountId: string,
  accountId: string,
): Record<string, never> {
  // 每次调用都记账（含被拒绝的）：GET /_sim/state 的 promoteCalls 供测试断言「调用总数 ≤ 2」
  try {
    const result = promoteInner(ctx, groupId, byAccountId, accountId);
    ctx.promoteCalls.push({
      groupId,
      byAccountId,
      accountId,
      status: 200,
      code: null,
    });
    return result;
  } catch (err) {
    if (err instanceof GatewayError) {
      ctx.promoteCalls.push({
        groupId,
        byAccountId,
        accountId,
        status: err.statusCode,
        code: err.code,
      });
    }
    throw err;
  }
}

function promoteInner(
  ctx: GatewayContext,
  groupId: string,
  byAccountId: string,
  accountId: string,
): Record<string, never> {
  const by = assertOnline(ctx, byAccountId);
  const group = getGroup(ctx, groupId);
  if (by.platformUserId !== group.ownerPlatformUserId || group.ownerLeft) {
    throw new GatewayError(
      403,
      "NO_PERMISSION",
      `账号 ${byAccountId} 不是群 ${groupId} 的群主，不能 promote`,
    );
  }
  const target = getOrCreateAccount(ctx, accountId);
  const member = group.members.get(target.platformUserId);
  if (!member) {
    throw new GatewayError(
      409,
      "NOT_MEMBER_YET",
      `账号 ${accountId} 尚未入群（member_joined 还没到）`,
    );
  }
  member.isAdmin = true;
  return {};
}

/**
 * kick：先移除、再（延迟）响应、响应之后推 member_left。
 * 场景 kick.timeout 非 null 时返回 504：removed=true 则在 convergeAfterMs 后移除并推事件，false 则什么都不发生。
 */
export async function kick(
  ctx: GatewayContext,
  groupId: string,
  byAccountId: string,
  targetPlatformUserId: string,
): Promise<{ kicked: true }> {
  const by = assertOnline(ctx, byAccountId);
  const group = getGroup(ctx, groupId);
  if (group.ownerLeft) {
    throw new GatewayError(
      409,
      "OWNER_LEFT",
      `群 ${groupId} 的群主已退群，不能再 kick`,
    );
  }
  const byMember = group.members.get(by.platformUserId);
  if (!byMember?.isAdmin) {
    throw new GatewayError(
      403,
      "NO_PERMISSION",
      `账号 ${byAccountId} 不是群主也未被 promote，不能 kick`,
    );
  }
  if (!group.members.has(targetPlatformUserId)) {
    throw new GatewayError(
      409,
      "NOT_IN_GROUP",
      `${targetPlatformUserId} 不在群 ${groupId} 里`,
    );
  }

  const { responseDelayMs, timeout } = ctx.scenario.kick;
  const delay = ctx.rng.fromRange(responseDelayMs);
  if (timeout) {
    if (timeout.removed) {
      ctx.timers.schedule(timeout.convergeAfterMs, () =>
        removeMember(ctx, group, targetPlatformUserId),
      );
    }
    await ctx.timers.sleep(delay);
    throw new GatewayError(
      504,
      "NETWORK_TIMEOUT",
      "kick 超时，结果未知；请用成员列表判断（2 秒内收敛）",
    );
  }

  // 目标在 200 返回前已从成员列表移除；member_left 在响应之后推（下一个宏任务）。
  group.members.delete(targetPlatformUserId);
  if (targetPlatformUserId === group.ownerPlatformUserId)
    group.ownerLeft = true;
  await ctx.timers.sleep(delay);
  ctx.timers.schedule(0, () =>
    emit(ctx, "member_left", { groupId, platformUserId: targetPlatformUserId }),
  );
  return { kicked: true };
}

/** leave：每次调用都记账（含被拒绝的）：GET /_sim/state 的 leaveCalls 供测试断言顺序与次数 */
export function leave(
  ctx: GatewayContext,
  groupId: string,
  accountId: string,
): Record<string, never> {
  try {
    const result = leaveInner(ctx, groupId, accountId);
    ctx.leaveCalls.push({ groupId, accountId, status: 200, code: null });
    return result;
  } catch (err) {
    if (err instanceof GatewayError) {
      ctx.leaveCalls.push({
        groupId,
        accountId,
        status: err.statusCode,
        code: err.code,
      });
    }
    throw err;
  }
}

function leaveInner(
  ctx: GatewayContext,
  groupId: string,
  accountId: string,
): Record<string, never> {
  const account = assertOnline(ctx, accountId);
  const group = getGroup(ctx, groupId);
  if (!group.members.has(account.platformUserId)) {
    throw new GatewayError(
      409,
      "NOT_IN_GROUP",
      `账号 ${accountId} 不在群 ${groupId} 里`,
    );
  }
  if (
    ctx.scenario.leave.fail ||
    ctx.scenario.leave.failAccountIds.includes(accountId)
  ) {
    throw new GatewayError(500, "INTERNAL", "leave 失败（场景：没退成）");
  }
  group.members.delete(account.platformUserId);
  if (account.platformUserId === group.ownerPlatformUserId) {
    group.ownerLeft = true;
  }
  ctx.timers.schedule(0, () =>
    emit(ctx, "member_left", {
      groupId,
      platformUserId: account.platformUserId,
    }),
  );
  return {};
}

export function listMembers(
  ctx: GatewayContext,
  groupId: string,
): { platformUserId: string }[] {
  const group = getGroup(ctx, groupId);
  return [...group.members.keys()].map((platformUserId) => ({
    platformUserId,
  }));
}
