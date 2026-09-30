// 闸门（preHandler）。地图只认这个文件导出的函数为闸门：
// 路由的 preHandler 里没有任何一个来自这里 → endpoint-without-auth 告警。
//
// requireUser：Authorization: Bearer <access token> → 验签（src/core/jwt.ts）→ request.principal。
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

declare module "fastify" {
  interface FastifyRequest {
    /** requireUser 通过后一定有；路由把它当普通参数传给 service */
    principal?: Principal;
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
  req.principal = {
    userId: result.claims.userId,
    username: result.claims.username,
    role: result.claims.role,
  };
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
