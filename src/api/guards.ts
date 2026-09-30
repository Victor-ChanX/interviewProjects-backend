// 闸门（preHandler）。地图只认这个文件导出的函数为闸门：
// 路由的 preHandler 里没有任何一个来自这里 → endpoint-without-auth 告警。
import type { FastifyReply, FastifyRequest } from "fastify";

import { Forbidden, Unauthorized } from "../core/errors.js";

export type CurrentUser = { id: string; roles: string[] };

declare module "fastify" {
  interface FastifyRequest {
    user?: CurrentUser;
  }
}

/**
 * 样例实现：只检查 Authorization: Bearer <token> 存在并把 token 当 userId。
 * 真项目在这里换成 JWT / session 校验；拒绝一律 throw 领域异常。
 */
export async function requireUser(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new Unauthorized();
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new Unauthorized();
  }
  // 样例：token 形如 "<userId>:<role1>,<role2>"
  const [id, roleList] = token.split(":");
  req.user = {
    id: id ?? token,
    roles: roleList ? roleList.split(",").filter(Boolean) : [],
  };
}

/**
 * 返回具名函数：地图收集 guards 时读的是函数的 .name，
 * 匿名箭头函数会变成 ""，所以这里用 defineProperty 固定名字。
 */
export function requireRole(role: string) {
  const fn = async function (
    req: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!req.user) {
      throw new Unauthorized();
    }
    if (!req.user.roles.includes(role)) {
      throw new Forbidden("FORBIDDEN", `需要 ${role} 角色`, { role });
    }
  };
  Object.defineProperty(fn, "name", { value: "requireRole" });
  return fn;
}
