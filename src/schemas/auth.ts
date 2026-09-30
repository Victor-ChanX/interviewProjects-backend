// 登录请求 / 响应（题目 2.3：POST /api/auth/login { username, password } → { accessToken }）。
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
