// 造数 / 登录辅助：测试里不自己拼登录，统一走这里。
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { getDb } from "../src/db/client.js";
import type { Account, Group, Prisma } from "../src/db/generated/client.js";
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

// ---- 领域造数（issue #4 起）：直接写库，供 schema / service 用例用；参数用 overrides 兜差异 ----

export async function makeAccount(
  overrides: Partial<Prisma.AccountUncheckedCreateInput> = {},
): Promise<Account> {
  const db = getDb();
  const id = overrides.id ?? `acc-${randomUUID().slice(0, 8)}`;
  return db.account.create({
    data: { platformUserId: `pu-${id}`, status: "online", ...overrides, id },
  });
}

/** 建群（本地记录；网关侧字段可空）。没给 creatorAccountId 就顺手建一个在线账号当群主。 */
export async function makeGroup(
  overrides: Partial<Prisma.GroupUncheckedCreateInput> = {},
): Promise<Group> {
  const db = getDb();
  const creatorAccountId =
    overrides.creatorAccountId ?? (await makeAccount()).id;
  return db.group.create({ data: { ...overrides, creatorAccountId } });
}
