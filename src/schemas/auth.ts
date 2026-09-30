// 登录 / 刷新 / 登出的请求与响应（题目 2.3：POST /api/auth/login { username, password } → { accessToken }；B3：refresh / logout）。
import { z } from "zod";

export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z
  .object({
    accessToken: z.string(),
  })
  .meta({ id: "LoginResponse" });
export type LoginResponse = z.infer<typeof LoginResponse>;

// ---- refresh / logout（题目 B3，issue #17）----
// refresh 的输入是 HttpOnly cookie，不是请求体，所以没有 request schema；响应与 login 同形。
export const RefreshResponse = LoginResponse;

export const LogoutResponse = z
  .object({
    ok: z.literal(true),
  })
  .meta({ id: "LogoutResponse" });
export type LogoutResponse = z.infer<typeof LogoutResponse>;
