// 闸门（挂在路由的 onRequest 上）。地图只认这个文件导出的函数为闸门：
// 路由的 onRequest / preHandler 里没有任何一个来自这里 → endpoint-without-auth 告警。
// 挂 onRequest 而不是 preHandler：onRequest 在请求体解析与 schema 校验**之前**跑，未登录 / 无权限的写请求
// 先拿到 401 / 403，不会因为请求体不合法先拿到 400（题目 A0：viewer 对所有写操作得到 403）。
//
// requireUser：Authorization: Bearer <access token> → 验签（src/core/jwt.ts）→ 按 sid 查会话未作废
// （src/services/auth-service.ts 的 assertSessionActive，issue #17）→ request.principal。
// requireRole(role)：在 requireUser 之后挂，身份不是该角色 → 403 FORBIDDEN。
// 拒绝一律 throw 领域异常，信封由 src/app.ts 的 setErrorHandler 产出：
// 401 = 不知道你是谁（没带 / 坏的 / 过期的 token），403 = 知道你是谁但这个操作不归你。
import type { FastifyReply, FastifyRequest } from "fastify";

import { Forbidden, Unauthorized } from "../core/errors.js";
import {
  type Principal,
  type Role,
  type VerifyFailure,
  verifyAccessToken,
} from "../core/jwt.js";
import {
  assertSessionActive,
  REFRESH_COOKIE_NAME,
} from "../services/auth-service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** requireUser 通过后一定有；路由把它当普通参数传给 service */
    principal?: Principal;
    /** requireUserOrRefreshCookie 在没有有效 Bearer 时放进来的 refresh token（只给登出用） */
    refreshCredential?: string;
  }
}

const FAILURE_MESSAGE: Readonly<Record<VerifyFailure, string>> = Object.freeze({
  malformed: "凭证无效，请重新登录",
  bad_signature: "凭证无效，请重新登录",
  expired: "登录已过期，请重新登录",
});

export async function requireUser(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new Unauthorized("UNAUTHORIZED", "未登录：缺少 Bearer 凭证");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new Unauthorized("UNAUTHORIZED", "未登录：缺少 Bearer 凭证");
  }
  const result = verifyAccessToken(token);
  if (!result.ok) {
    throw new Unauthorized("UNAUTHORIZED", FAILURE_MESSAGE[result.reason], {
      reason: result.reason,
    });
  }
  // 签名对了还要看会话：logout / refresh 复用作废后，同族的 access token 在 15 分钟到期前就要失效（#17）。
  // 副本 A 上 logout 的会话，副本 B 只有查库才知道。
  await assertSessionActive(result.claims.sessionId);
  req.principal = {
    userId: result.claims.userId,
    username: result.claims.username,
    role: result.claims.role,
    sessionId: result.claims.sessionId,
  };
}

/**
 * 登出专用：有效的 Bearer 与 refresh cookie 二者有其一即可。access token 过期（15 分钟）之后用户仍要能登出，
 * 否则 refresh 会话继续有效、拿 cookie 还能换出新 token。有有效 Bearer → 同 requireUser；否则有 refresh cookie →
 * req.refreshCredential（由 service 按它找族作废）；两者都没有 → 401。
 */
export async function requireUserOrRefreshCookie(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cookie = req.cookies[REFRESH_COOKIE_NAME];
  try {
    await requireUser(req, reply);
    return;
  } catch (err) {
    if (!(err instanceof Unauthorized) || !cookie) throw err;
  }
  req.refreshCredential = cookie;
}

/**
 * 返回具名函数：地图收集 guards 时读的是函数的 .name，
 * 匿名箭头函数会变成 ""，所以这里用 defineProperty 固定名字。
 */
export function requireRole(role: Role) {
  const fn = async function (
    req: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    // 没先过 requireUser 是路由声明写错了（闸门顺序），仍按 401 处理而不是 500
    if (!req.principal) {
      throw new Unauthorized("UNAUTHORIZED", "未登录：缺少 Bearer 凭证");
    }
    if (req.principal.role !== role) {
      throw new Forbidden("FORBIDDEN", "当前账号没有权限执行此操作", {
        requiredRole: role,
      });
    }
  };
  Object.defineProperty(fn, "name", { value: "requireRole" });
  return fn;
}
