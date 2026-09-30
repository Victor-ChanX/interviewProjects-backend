// 登录：users 表查用户 → scrypt 校验（src/core/password.ts）→ 签发 access token（src/core/jwt.ts）。
// 用户名不存在与密码错误给同一句 401 UNAUTHORIZED（不暴露哪个用户名存在）。
// refresh / logout / sessions 表（issue #17）以后接在这里：login 到时多返回一个 refresh token，
// 响应形状 { accessToken } 不变。
import type { Clock } from "../core/clock.js";
import { Unauthorized } from "../core/errors.js";
import { type Principal, signAccessToken } from "../core/jwt.js";
import { verifyPassword } from "../core/password.js";
import { getDb } from "../db/client.js";

export type LoginResult = { accessToken: string };

export async function login(
  username: string,
  password: string,
  deps: { clock?: Clock } = {},
): Promise<LoginResult> {
  const user = await getDb().user.findUnique({
    where: { username },
    select: { id: true, username: true, passwordHash: true, role: true },
  });
  // 两条失败路径同一个码、同一句话；verifyPassword 对坏格式的哈希返回 false 而不抛
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new Unauthorized("UNAUTHORIZED", "用户名或密码错误");
  }
  const principal: Principal = {
    userId: user.id,
    username: user.username,
    role: user.role,
  };
  return { accessToken: signAccessToken(principal, { clock: deps.clock }) };
}
