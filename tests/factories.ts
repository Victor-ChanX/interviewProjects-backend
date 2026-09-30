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
  AgentRun,
  AgentRunEndReason,
  AgentRunStatus,
  Group,
  Inconsistency,
  Message,
  Prisma,
  Session,
  WsEvent,
} from "../src/db/generated/client.js";
import { SEED_USERS } from "../src/db/seed.js";
import { REFRESH_COOKIE_NAME } from "../src/services/auth-service.js";
import type { GatewayClient } from "../src/services/gateway-client.js";
import {
  type ApplyDeliveryResult,
  applyGatewayDelivery,
  type GatewayDeliveryInput,
} from "../src/services/outbox-service.js";
import {
  assignWsSeqs,
  emitWsEvent,
  type WsEventType,
} from "../src/services/ws-events.js";


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
 * #17 起 access token 带 sid，requireUser 会按它查 sessions 行：这里顺手建该用户（id = username = userId）
 * 与一行会话，所以是 async；传 opts.sessionId 则不建行、直接签（测「sid 指向不存在的会话 → 401」）。
 */
export async function authHeaders(
  userId = "u1",
  roles: string[] = [],
  opts: { clock?: Clock; ttlSeconds?: number; sessionId?: string } = {},
): Promise<Record<string, string>> {
  const role: Role = roles.includes("admin") ? "admin" : "viewer";
  const sessionId = opts.sessionId ?? (await makeSession(userId, role)).id;
  const token = signAccessToken(
    { userId, username: userId, role, sessionId },
    opts,
  );
  return { authorization: `Bearer ${token}` };
}

/** 直接写库建一个用户（不存在才建；id 与 username 同为 userId）+ 一行会话（新族）。给不走登录端点的用例用。 */
export async function makeSession(
  userId: string,
  role: Role,
  overrides: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<Session> {
  const db = getDb();
  await db.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      username: userId,
      passwordHash: await hashPassword(randomUUID()),
      role,
    },
  });
  return db.session.create({
    data: {
      userId,
      tokenFamily: randomUUID(),
      tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    },
  });
}

// ---- 会话（issue #17）：refresh / logout 也只在这里拼路径 ----

const REFRESH_PATH = "/api/auth/refresh";
const LOGOUT_PATH = "/api/auth/logout";

/** 从登录 / 刷新响应里取 refresh cookie（light-my-request 把 Set-Cookie 解析成 res.cookies）；没有则 undefined。 */
export function refreshCookieFrom(
  res: LightMyRequestResponse,
): LightMyRequestResponse["cookies"][number] | undefined {
  return res.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
}

/** 打刷新端点。refreshToken 不给 → 不带 cookie（测「无 cookie 401」）。 */
export async function refresh(
  app: FastifyInstance,
  refreshToken?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: REFRESH_PATH,
    ...(refreshToken !== undefined
      ? { cookies: { [REFRESH_COOKIE_NAME]: refreshToken } }
      : {}),
  });
}

/** 打登出端点（Bearer 从 headers 来）。 */
export async function logout(
  app: FastifyInstance,
  headers: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: LOGOUT_PATH, headers });
}

export type SessionLogin = {
  /** 带 Bearer 的 headers，与 loginAs 同形 */
  headers: Record<string, string>;
  accessToken: string;
  /** cookie 里的 refresh token 原文 */
  refreshToken: string;
};

/** loginAs 的加强版：同时拿到 refresh token（会话用例要它；loginAs 的签名不变）。 */
export async function loginSession(
  app: FastifyInstance,
  role: Role,
): Promise<SessionLogin> {
  const user = SEED_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`种子里没有角色为 ${role} 的用户`);
  await ensureSeedUser(user.username);
  const res = await login(app, {
    username: user.username,
    password: user.password,
  });
  if (res.statusCode !== 200) {
    throw new Error(
      `loginSession(${role}) 失败：${res.statusCode} ${res.body}`,
    );
  }
  const { accessToken } = res.json<{ accessToken: string }>();
  const cookie = refreshCookieFrom(res);
  if (!cookie) throw new Error("登录响应没有 refresh cookie");
  return {
    headers: { authorization: `Bearer ${accessToken}` },
    accessToken,
    refreshToken: cookie.value,
  };
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

/** 各终态默认配的 endReason（库里 CHECK agent_runs_end_reason_matches_status 要求二者匹配） */
const DEFAULT_END_REASON: Readonly<
  Record<AgentRunStatus, AgentRunEndReason | null>
> = {
  running: null,
  finished: "final",
  failed: "budget_exhausted",
  blocked: "audit_blocked",
  cancelled: "cancelled",
};

/**
 * 往 agent_runs 直接插一行（列表 / 统计用例）。status 默认 running（同群至多一个 running：部分唯一索引）；
 * endReason 按 status 取默认值，非 running 的 finishedAt 默认等于 createdAt。createdAt 默认「现在」，排序相关的用例显式传。
 */
export async function makeAgentRun(
  overrides: Partial<Prisma.AgentRunUncheckedCreateInput> & { groupId: string },
): Promise<AgentRun> {
  const status = overrides.status ?? "running";
  const createdAt = overrides.createdAt ?? new Date();
  return getDb().agentRun.create({
    data: {
      triggerMessages: [],
      endReason: DEFAULT_END_REASON[status],
      finishedAt: status === "running" ? null : createdAt,
      ...overrides,
      status,
      createdAt,
    },
  });
}

/** 往 inconsistencies 直接插一行（异常中心 / 统计用例）。createdAt 默认「现在」，排序相关的用例显式传。 */
export async function makeInconsistency(
  overrides: Partial<Prisma.InconsistencyUncheckedCreateInput> = {},
): Promise<Inconsistency> {
  return getDb().inconsistency.create({
    data: {
      kind: "inbound_event_failed",
      ref: `evt-${randomUUID().slice(0, 8)}`,
      message: "处理网关事件写库失败",
      payload: { note: "test" },
      ...overrides,
    },
  });
}

// ---- 网关回执（message_sent / message_failed）------------------------------------------

/**
 * 模拟入站 worker 收到一条 message_sent / message_failed：在一个事务里调 outbox-service.applyGatewayDelivery
 * （生产里它跑在处理这条事件的事务中），commit 之后执行它登记的日志。
 */
export async function deliverGatewayReceipt(
  input: GatewayDeliveryInput,
  deps: {
    clock?: Clock;
    log?: Parameters<typeof applyGatewayDelivery>[2]["log"];
  } = {},
): Promise<ApplyDeliveryResult> {
  const committed: (() => void)[] = [];
  const result = await getDb().$transaction((tx) =>
    applyGatewayDelivery(tx, input, {
      ...deps,
      afterCommit: (fn) => committed.push(fn),
    }),
  );
  for (const fn of committed) fn();
  return result;
}

// ---- ws_events ------------------------------------------------------------------------

/**
 * 写一条 ws 事件并立刻排号（生产里 ws-hub 每次轮询先调 assignWsSeqs），返回带 seq 的行：
 * 给要按 seq 断言顺序 / 游标的用例用。
 */
export async function publishWsEvent(
  type: WsEventType,
  payload: Prisma.InputJsonObject,
): Promise<WsEvent & { seq: number }> {
  const row = await emitWsEvent(getDb(), type, payload);
  await assignWsSeqs(getDb());
  const published = await getDb().wsEvent.findUniqueOrThrow({
    where: { id: row.id },
  });
  if (published.seq === null) throw new Error(`ws_events ${row.id} 没排上号`);
  return { ...published, seq: published.seq };
}

// ---- 故障注入 --------------------------------------------------------------------------

/**
 * 在 fn 执行期间，让 table 上满足 when（触发器的 WHEN 条件，引用 NEW）的 UPDATE 抛错：模拟事务中途的库错误，
 * 验证「要么都生效，要么都不生效」。结束后删掉触发器。表在测试的临时 schema 里（search_path）。
 */
export async function withFailingUpdates<T>(
  table: string,
  when: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = getDb();
  await db.$executeRawUnsafe(
    `CREATE FUNCTION injected_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER injected_failure BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION injected_failure()`,
  );
  try {
    return await fn();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER injected_failure ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION injected_failure()`);
  }
}

// ---- 网关事件流 ------------------------------------------------------------------------

/**
 * 包一层网关客户端的事件流：消费方每处理完一帧（来要下一帧时）计数一次，stop(已处理帧数, eventId) 为真就 abort
 * 并结束这条流 —— 让入站 worker 的一次连接停在确定的帧上（相当于 stop()），不往生产代码里加测试钩子。
 */
export function stopAfterFrames(
  gateway: Pick<GatewayClient, "openEventStream">,
  stop: (frames: number, eventId: number) => boolean,
  controller: AbortController,
): Pick<GatewayClient, "openEventStream"> {
  return {
    async *openEventStream(opts) {
      let frames = 0;
      for await (const event of gateway.openEventStream(opts)) {
        yield event;
        frames += 1;
        if (stop(frames, event.eventId)) {
          controller.abort();
          return;
        }
      }
    },
  };
}
