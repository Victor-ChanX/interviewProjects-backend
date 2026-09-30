// 造数 / 登录辅助：测试里不自己拼登录，统一走这里。
import { randomUUID } from "node:crypto";

import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";

import type { Clock } from "../src/core/clock.js";
import { type Role, signAccessToken } from "../src/core/jwt.js";
import { hashPassword } from "../src/core/password.js";
import { getDb } from "../src/db/client.js";
import type {
  Account,
  Group,
  Message,
  Prisma,
} from "../src/db/generated/client.js";
import { SEED_USERS } from "../src/db/seed.js";


const LOGIN_PATH = "/api/auth/login";

/** 直接打登录端点，返回原始响应：给「测登录本身」的用例用（成功 / 失败 / 校验错）。 */
export async function login(
  app: FastifyInstance,
  payload: InjectOptions["payload"],
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: LOGIN_PATH, payload });
}

/**
 * 以预置用户（admin / viewer，src/db/seed.ts 的 SEED_USERS）登录，返回带 Bearer 的 headers。
 * 用例间 truncateAll 会清掉 users，所以先确保该用户存在（幂等 upsert，口令哈希与种子同一套）。
 */
export async function loginAs(
  app: FastifyInstance,
  role: Role,
): Promise<Record<string, string>> {
  const user = SEED_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`种子里没有角色为 ${role} 的用户`);
  await ensureSeedUser(user.username);
  const res = await login(app, {
    username: user.username,
    password: user.password,
  });
  if (res.statusCode !== 200) {
    throw new Error(`loginAs(${role}) 失败：${res.statusCode} ${res.body}`);
  }
  const { accessToken } = res.json<{ accessToken: string }>();
  return { authorization: `Bearer ${accessToken}` };
}

/** 幂等：已存在的行不动，不存在才算一次哈希并插入。 */
export async function ensureSeedUser(username: string) {
  const seed = SEED_USERS.find((u) => u.username === username);
  if (!seed) throw new Error(`种子里没有用户 ${username}`);
  const db = getDb();
  const existing = await db.user.findUnique({ where: { username } });
  if (existing) return existing;
  return db.user.create({
    data: {
      username,
      passwordHash: await hashPassword(seed.password),
      role: seed.role,
    },
  });
}

/**
 * 不经登录端点直接签一个 token（jti / 过期时刻可控）：给「过期 401」「伪造签名 401」这类
 * 用例用。签名密钥与被测应用同一个（tests/setup.ts 设的 JWT_SECRET）。
 */
export function authHeaders(
  userId = "u1",
  roles: string[] = [],
  opts: { clock?: Clock; ttlSeconds?: number } = {},
): Record<string, string> {
  const token = signAccessToken(
    {
      userId,
      username: userId,
      role: roles.includes("admin") ? "admin" : "viewer",
    },
    opts,
  );
  return { authorization: `Bearer ${token}` };
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

/**
 * 往 messages 表直接插一行（时间线 / outbox 用例）：默认是别人发的入站消息（isOwn = false、deliveryStatus null）；
 * 自己的出站行传 { isOwn: true, deliveryStatus: "queued", clientMsgId, accountId }。sentAt 默认「现在」，
 * 排序相关的用例显式传（毫秒精度：游标按 ISO 毫秒编码）。
 */
export async function makeMessage(
  overrides: Partial<Prisma.MessageUncheckedCreateInput> & { groupId: string },
): Promise<Message> {
  const db = getDb();
  return db.message.create({
    data: {
      senderPlatformUserId: `pu-${randomUUID().slice(0, 8)}`,
      text: `msg-${randomUUID().slice(0, 8)}`,
      sentAt: new Date(),
      ...overrides,
    },
  });
}

/** 从 loginAs / authHeaders 返回的 headers 里取出裸 access token（WebSocket 的 auth 帧要它，不是 Authorization 头）。 */
export function tokenFrom(headers: Record<string, string>): string {
  const header = headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}
