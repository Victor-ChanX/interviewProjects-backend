// 登录会话（题目 2.3 login 行 + B3；issue #5 / #17）。
//
// 登录：users 表查用户 → scrypt 校验（src/core/password.ts）→ 建会话 → 签发 access token（src/core/jwt.ts）。
// 用户名不存在与密码错误给同一句 401 UNAUTHORIZED（不暴露哪个用户名存在）。
//
// 会话模型（sessions 表，一行 = 一枚 refresh token）：
// - login 建一个会话族 tokenFamily（uuid）+ 第一枚 refresh token：随机 32 字节 base64url 原文只经 HttpOnly cookie
//   下发给浏览器，库里只存 sha256（tokenHash，unique）—— 拖库拿不到能用的 token。
// - access token 的 sid claim = 该 sessions 行 id。requireUser 验签后按 sid 查该行 revokedAt（assertSessionActive），
//   所以 logout / 复用作废后**同族的所有 access token 在 15 分钟到期之前就失效**。
// - refresh（POST /api/auth/refresh，只读 cookie）：按 tokenHash 找行：
//     不存在 → 401；已 revokedAt / 过期 → 401；
//     已 rotatedAt（旧 token 再被使用）→ 判定为泄露：整族 revokedAt = now，401 —— 之前换出的新 refresh 与新 access
//       （sid 指向族内的行）都随之失效；这是题目 B3 的语义，也覆盖两个并发 refresh 用同一枚 token 的情形：
//       后到的那个看到 rotatedAt 已置，把先到那个刚换出的也一并作废（宁可让用户重新登录，不猜哪个是攻击者）。
//     正常 → 同一事务里旧行 rotatedAt = now、同族新增一行（新 hash、新 expiresAt），签发新 access（sid = 新行）。
//   「旧行置 rotatedAt」用带 rotatedAt IS NULL 条件的 updateMany 做 CAS：并发时恰好一个 count = 1 胜出，
//   另一个 count = 0 后重读该行再分辨是哪种拒绝；Postgres 的行锁让后到的 UPDATE 等先到的事务提交后再判条件，
//   所以后到者作废整族时先到者的新行已经可见，不会漏掉。
// - logout（POST /api/auth/logout，requireUser）：按 access token 的 sid 找到族，整族 revokedAt = now；路由清 cookie。
//   重复 logout / 已作废的族再 logout 是幂等的（requireUser 已经先按 sid 挡下作废族的 token → 401）。
//
// 为什么每个请求都查一次库而不做进程内缓存 / 作废名单：多副本各算各的（副本 A 上 logout，副本 B 的内存里不知道），
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.js";
import { config } from "../core/config.js";
import { Unauthorized } from "../core/errors.js";
import { type Principal, signAccessToken } from "../core/jwt.js";
import { UNUSABLE_PASSWORD_HASH, verifyPassword } from "../core/password.js";
import { getDb } from "../db/client.js";

/** refresh token 的 cookie 名。 */
export const REFRESH_COOKIE_NAME = "refresh_token";
/** cookie 的 Path：浏览器只在打 /api/auth/* 时回传，别的接口拿不到它。 */
export const REFRESH_COOKIE_PATH = "/api/auth";
/** refresh token 有效期（题目没规定；每次刷新换新一枚、期限重新起算）：7 天。 */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * cookie 属性（Set-Cookie 与清除都用同一组，否则浏览器认为是两个不同的 cookie 而清不掉）。
 * HttpOnly：脚本读不到；SameSite=Strict：跨站请求不带；Secure：生产 HTTPS 下才带（src/core/config.ts）。
 * 属性是纯数据，HTTP 层（路由）拿去 setCookie / clearCookie，本模块不 import fastify。
 */
export function refreshCookieAttributes(): {
  httpOnly: true;
  sameSite: "strict";
  path: string;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    secure: config.cookieSecure,
  };
}

export type LoginResult = {
  accessToken: string;
  /** refresh token 原文：只进 HttpOnly cookie，路由不得把它放进响应体。 */
  refreshToken: string;
  /** 该 refresh token 的过期时刻（cookie 的 Expires 用它）。 */
  refreshExpiresAt: Date;
};

type Deps = { clock?: Clock };

function now(deps: Deps): Date {
  return deps.clock?.now() ?? new Date();
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

export async function login(
  username: string,
  password: string,
  deps: Deps = {},
): Promise<LoginResult> {
  const user = await getDb().user.findUnique({
    where: { username },
    select: { id: true, username: true, passwordHash: true, role: true },
  });
  // 两条失败路径同一个码、同一句话、同样的耗时（用户不存在也跑一遍 scrypt）；verifyPassword 对坏格式的哈希返回 false 而不抛
  const valid = await verifyPassword(
    password,
    user?.passwordHash ?? UNUSABLE_PASSWORD_HASH,
  );
  if (!user || !valid) {
    throw new Unauthorized("UNAUTHORIZED", "用户名或密码错误");
  }
  const at = now(deps);
  const token = newRefreshToken();
  const refreshExpiresAt = new Date(
    at.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  );
  const session = await getDb().session.create({
    data: {
      userId: user.id,
      tokenFamily: randomUUID(),
      tokenHash: token.hash,
      expiresAt: refreshExpiresAt,
    },
    select: { id: true },
  });
  const principal: Principal = {
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionId: session.id,
  };
  return {
    accessToken: signAccessToken(principal, { clock: deps.clock }),
    refreshToken: token.raw,
    refreshExpiresAt,
  };
}

/**
 * refresh：见文件头。拒绝一律 401 UNAUTHORIZED，extra.reason 区分（前端统一跳登录，reason 只为排障）：
 * unknown（找不到 / 没带）、revoked（族已作废）、expired、reused（旧 token 再被使用 → 本次把整族作废）。
 */
export async function refresh(
  rawToken: string | undefined,
  deps: Deps = {},
): Promise<LoginResult> {
  if (!rawToken) {
    throw new Unauthorized("UNAUTHORIZED", "未登录：缺少 refresh token", {
      reason: "unknown",
    });
  }
  const db = getDb();
  const at = now(deps);
  const tokenHash = hashToken(rawToken);
  const next = newRefreshToken();
  const refreshExpiresAt = new Date(
    at.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  );

  // 胜出路径：一个事务里 CAS 置 rotatedAt + 同族插新行。两个并发 refresh 只有一个 count = 1。
  const rotated = await db.$transaction(async (tx) => {
    const { count } = await tx.session.updateMany({
      where: {
        tokenHash,
        rotatedAt: null,
        revokedAt: null,
        expiresAt: { gt: at },
      },
      data: { rotatedAt: at },
    });
    if (count !== 1) return null;
    const old = await tx.session.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        tokenFamily: true,
        user: { select: { id: true, username: true, role: true } },
      },
    });
    const created = await tx.session.create({
      data: {
        userId: old.user.id,
        tokenFamily: old.tokenFamily,
        tokenHash: next.hash,
        expiresAt: refreshExpiresAt,
      },
      select: { id: true },
    });
    return { sessionId: created.id, user: old.user };
  });

  if (rotated) {
    const principal: Principal = {
      userId: rotated.user.id,
      username: rotated.user.username,
      role: rotated.user.role,
      sessionId: rotated.sessionId,
    };
    return {
      accessToken: signAccessToken(principal, { clock: deps.clock }),
      refreshToken: next.raw,
      refreshExpiresAt,
    };
  }

  // CAS 没中：重读分辨原因。顺序：不存在 → 已作废 → 过期 → 已轮换（复用）。
  // 已作废的族里的旧行也带 rotatedAt，先判 revoked 免得把「作废后再来」当成第二次泄露又作废一遍（结果一样，只是少一次写）。
  const row = await db.session.findUnique({
    where: { tokenHash },
    select: {
      tokenFamily: true,
      rotatedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!row) {
    throw new Unauthorized("UNAUTHORIZED", "登录已失效，请重新登录", {
      reason: "unknown",
    });
  }
  if (row.revokedAt) {
    throw new Unauthorized("UNAUTHORIZED", "登录已失效，请重新登录", {
      reason: "revoked",
    });
  }
  if (row.expiresAt <= at) {
    throw new Unauthorized("UNAUTHORIZED", "登录已过期，请重新登录", {
      reason: "expired",
    });
  }
  // rotatedAt 已置：旧 token 再被使用 → 整族作废（含刚换出的那一行）
  const { count } = await revokeFamily(row.tokenFamily, at);
  throw new Unauthorized("UNAUTHORIZED", "登录已失效，请重新登录", {
    reason: "reused",
    revokedCount: count,
  });
}

/** 整族作废（幂等：已作废的行不动，保留最早的 revokedAt）。返回本次真正改动的行数。 */
async function revokeFamily(
  tokenFamily: string,
  at: Date,
): Promise<{ count: number }> {
  return getDb().session.updateMany({
    where: { tokenFamily, revokedAt: null },
    data: { revokedAt: at },
  });
}

/**
 * logout：按 access token 的 sid 找到族，整族作废。sid 指向的行不存在时（被删的用户）当作已登出，不报错。
 * 返回作废的行数（业务上不下发，只进日志）。
 */
export async function logout(
  sessionId: string,
  deps: Deps = {},
): Promise<{ revokedCount: number }> {
  const row = await getDb().session.findUnique({
    where: { id: sessionId },
    select: { tokenFamily: true },
  });
  if (!row) return { revokedCount: 0 };
  const { count } = await revokeFamily(row.tokenFamily, now(deps));
  return { revokedCount: count };
}

/**
 * 按 refresh token 登出（access token 已过期、只剩 cookie 时）：找到它所在的族，整族作废。
 * 不认识的 token 当作已登出，不报错 —— 登出是幂等的收尾动作，不给调用方探测 token 是否有效的机会。
 */
export async function logoutByRefreshToken(
  rawToken: string,
  deps: Deps = {},
): Promise<{ revokedCount: number }> {
  const row = await getDb().session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { tokenFamily: true },
  });
  if (!row) return { revokedCount: 0 };
  const { count } = await revokeFamily(row.tokenFamily, now(deps));
  return { revokedCount: count };
}

/**
 * requireUser 验签后调：sid 指向的会话行还在且未作废才放行。
 * 行不存在（用户被删、库被清）也是 401：签名对但会话已不在，与作废同样处理。
 * refresh 过的旧行只置 rotatedAt、不置 revokedAt，所以旧 access token 在 15 分钟内照常可用（题目只要求
 * 「旧 refresh 再被使用 → 整族作废」与「logout 后立即失效」）。
 */
export async function assertSessionActive(sessionId: string): Promise<void> {
  if (!(await isSessionActive(sessionId))) {
    throw new Unauthorized("UNAUTHORIZED", "登录已失效，请重新登录", {
      reason: "session_revoked",
    });
  }
}

/** 同上，不抛：WS 的 auth 帧（src/api/routes/ws.ts）拒绝方式是回帧 + 关连接，不走错误信封。 */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const row = await getDb().session.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true },
  });
  return row !== null && row.revokedAt === null;
}
