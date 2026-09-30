// PUBLIC_ENDPOINTS。refresh / logout（issue #17）以后加在同一个插件里。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { LoginRequest, LoginResponse } from "../../schemas/auth.js";
import { login } from "../../services/auth-service.js";

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/auth/login",
    {
      schema: {
        summary: "用户名密码登录，签发 access token",
        tags: ["auth"],
        body: LoginRequest,
        response: { 200: LoginResponse },
      },
    },
    async (req) => login(req.body.username, req.body.password),
  );
}
