// 造数 / 登录辅助：测试里不自己拼登录，统一走这里。
import type { FastifyInstance } from "fastify";

import { createExample } from "../src/services/example-service.js";

/** 样例项目没有登录端点，直接拼 Bearer；真项目在这里用 app.inject 打登录接口 */
export function authHeaders(
  userId = "u1",
  roles: string[] = [],
): Record<string, string> {
  return { authorization: `Bearer ${userId}:${roles.join(",")}` };
}

export async function makeExample(
  _app: FastifyInstance,
  overrides: { name?: string } = {},
) {
  return createExample({
    name: overrides.name ?? `example-${Math.random().toString(36).slice(2)}`,
  });
}
