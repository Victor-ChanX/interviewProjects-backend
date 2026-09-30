// 登录 / 刷新 / 登出端点（题目 2.3 + B3；issue #5 / #17）。
//
//   PUBLIC_ENDPOINTS。响应体 { accessToken }，refresh token 只进 HttpOnly cookie（Set-Cookie）。
// - POST /api/auth/refresh：公开（凭证是 cookie，不是 Bearer；同样登记在 PUBLIC_ENDPOINTS）。**只读 cookie，不读 body**：
//   题目要求 refresh token 不出现在响应体，对称地也不从请求体收，否则 XSS 拿到的字符串就能拿来刷新。
//   成功 → { accessToken } + 新 Set-Cookie；任何失败 → 401 UNAUTHORIZED（service 抛，信封由 src/app.ts 产出）。
// - POST /api/auth/logout：requireUserOrRefreshCookie（有效 Bearer 或 refresh cookie 其一；access token 过期后
//   也要能登出）。整族作废后清 cookie → { ok: true }。
//
// cookie 名与属性都从 src/services/auth-service.ts 拿（HttpOnly / SameSite=Strict / Path=/api/auth / 生产 Secure），
// Set-Cookie 与清除用同一组属性，否则浏览器认为是不同 cookie 而清不掉。
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
} from "../../schemas/auth.js";
import {
  login,
  type LoginResult,
  logout,
  logoutByRefreshToken,
  REFRESH_COOKIE_NAME,
  refresh,
  refreshCookieAttributes,
} from "../../services/auth-service.js";
import { requireUserOrRefreshCookie } from "../guards.js";

/** 把 service 的结果拆成「响应体」与「cookie」：refresh token 只走后者。 */
function issue(
  reply: FastifyReply,
  result: LoginResult,
): { accessToken: string } {
  reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    ...refreshCookieAttributes(),
    expires: result.refreshExpiresAt,
  });
  return { accessToken: result.accessToken };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/auth/login",
    {
      schema: {
        summary:
          "用户名密码登录，签发 access token；refresh token 只进 HttpOnly cookie",
        tags: ["auth"],
        body: LoginRequest,
        response: { 200: LoginResponse },
      },
    },
    async (req, reply) =>
      issue(reply, await login(req.body.username, req.body.password)),
  );

  r.post(
    "/api/auth/refresh",
    {
      schema: {
        summary:
          "用 HttpOnly cookie 里的 refresh token 换新 access token（轮换；旧 token 复用则整个会话作废）",
        tags: ["auth"],
        response: { 200: RefreshResponse },
      },
    },
    async (req, reply) => {
      // 只读 cookie，不读 body / header
      const result = await refresh(req.cookies[REFRESH_COOKIE_NAME]);
      return issue(reply, result);
    },
  );

  r.post(
    "/api/auth/logout",
    {
      onRequest: [requireUserOrRefreshCookie],
      schema: {
        summary:
          "登出：整个会话族作废，同一 access token 立即失效，清 refresh cookie（access token 过期时凭 cookie）",
        tags: ["auth"],
        response: { 200: LogoutResponse },
      },
    },
    async (req, reply) => {
      // 闸门保证二者有其一：principal（有效 Bearer）或 refreshCredential（只剩 cookie）
      const { revokedCount } = req.principal
        ? await logout(req.principal.sessionId)
        : await logoutByRefreshToken(req.refreshCredential ?? "");
      req.log.info(
        { userId: req.principal?.userId ?? null, revokedCount },
        "已登出，会话族作废",
      );
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieAttributes());
      return { ok: true as const };
    },
  );
}
