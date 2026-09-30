// 网关模拟器的全部运行时状态：一个 GatewayContext，由 buildGatewayApp 创建、挂在闭包里
// （不是模块级变量 —— 每个 buildGatewayApp 各一份，测试里可以并排起多个实例）。
// 模拟器是「外部服务」，状态只在内存里：重启即清空，这与题目「网关保留全部历史事件」并不矛盾 ——
// 那说的是它运行期间的历史。可注入的部分：时钟（src/core/clock.ts 的 Clock）、随机源（rng）、定时器。
import { randomInt } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { Clock } from "../../core/clock.js";
import { defaultScenario, type Range, type Scenario } from "./scenario.js";

// ---- 可注入的基础设施 ----

export interface Rng {
  /** [0, 1) */
  unit(): number;
  /** [min, max] 的整数 */
  int(min: number, max: number): number;
  fromRange(range: Range): number;
}

export function createRng(unit: () => number): Rng {
  const int = (min: number, max: number): number =>
    max <= min ? min : min + Math.floor(unit() * (max - min + 1));
  return { unit, int, fromRange: (r) => int(r.min, r.max) };
}

/** 默认随机源：node:crypto，不用 Math.random。 */
export const cryptoUnit = (): number => randomInt(0, 1 << 30) / (1 << 30);

/**
 * 定时器登记簿：模拟器里所有「过一会儿再推事件 / 再响应」都经这里，reset / close 时一把清掉，
 * 免得上一个用例的定时器在下一个用例里触发。测试用 vi.useFakeTimers 推进即可（底层就是 setTimeout）。
 */
export interface Timers {
  schedule(ms: number, fn: () => void): void;
  /** 返回在 ms 后 resolve 的 Promise（用于延迟响应） */
  sleep(ms: number): Promise<void>;
  pending(): number;
  clearAll(): void;
}

export function createTimers(): Timers {
  const handles = new Set<NodeJS.Timeout>();
  const schedule = (ms: number, fn: () => void): void => {
    const handle = setTimeout(() => {
      handles.delete(handle);
      fn();
    }, ms);
    handles.add(handle);
  };
  return {
    schedule,
    // 0 延时直接 resolve：不占一个定时器 tick（假定时器下 inject 不用先推进时间）。
    sleep: (ms) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise((resolve) => schedule(ms, resolve)),
    pending: () => handles.size,
    clearAll: () => {
      for (const h of handles) clearTimeout(h);
      handles.clear();
    },
  };
}

// ---- 领域状态 ----

export type AccountStatus = "active" | "suspended" | "session_expired";

export interface Account {
  accountId: string;
  platformUserId: string;
  online: boolean;
  status: AccountStatus;
  /** 限流截止（epoch ms）；null = 未限流 */
  rateLimitedUntil: number | null;
  /** 限流期内每次 send 回显的 retryAfterSeconds（计时重置，但秒数不变） */
  rateLimitRetryAfterSeconds: number | null;
}

export interface Member {
  platformUserId: string;
  isAdmin: boolean;
}

export interface Invite {
  inviteLink: string;
  groupId: string;
  readyAt: number;
  expiresAt: number | null;
}

export interface Group {
  groupId: string;
  ownerAccountId: string;
  ownerPlatformUserId: string;
  ownerLeft: boolean;
  writeForbidden: boolean;
  members: Map<string, Member>;
  /** 已受理、member_joined 尚未推的 platformUserId */
  pendingJoins: Set<string>;
}

export interface StoredMessage {
  msgId: string;
  groupId: string;
  /** 服务账号发的才有；外部用户消息为 null */
  clientMsgId: string | null;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
  mediaUrl?: string;
}

export interface SendCall {
  accountId: string;
  groupId: string;
  clientMsgId: string;
  status: number;
  code: string | null;
}

export interface Media {
  id: string;
  contentType: string;
  bytes: Buffer;
  expiresAt: number | null;
}

export type EventType =
  | "message"
  | "message_sent"
  | "message_failed"
  | "member_joined"
  | "member_left"
  | "account_status";

export interface GatewayEvent {
  eventId: number;
  type: EventType;
  data: Record<string, unknown>;
}

export interface Stream {
  res: ServerResponse;
  frames: number;
}

export interface GatewayContext {
  clock: Clock;
  rng: Rng;
  timers: Timers;
  /** mediaUrl 的前缀（真实监听时是 http://host:port；测试里可以为空 = 相对路径） */
  publicUrl: string;
  scenario: Scenario;
  accounts: Map<string, Account>;
  groups: Map<string, Group>;
  invites: Map<string, Invite>;
  messages: StoredMessage[];
  sendCalls: SendCall[];
  media: Map<string, Media>;
  events: GatewayEvent[];
  eventSeq: number;
  streams: Set<Stream>;
}

export function createContext(opts: {
  clock: Clock;
  rng: Rng;
  publicUrl: string;
}): GatewayContext {
  return {
    clock: opts.clock,
    rng: opts.rng,
    timers: createTimers(),
    publicUrl: opts.publicUrl,
    scenario: defaultScenario(),
    accounts: new Map(),
    groups: new Map(),
    invites: new Map(),
    messages: [],
    sendCalls: [],
    media: new Map(),
    events: [],
    eventSeq: 0,
    streams: new Set(),
  };
}

/** POST /_sim/reset：清空一切（含定时器与场景），eventId 从 1 重新开始。SSE 连接由调用方决定是否掐断。 */
export function resetContext(ctx: GatewayContext): void {
  ctx.timers.clearAll();
  ctx.scenario = defaultScenario();
  ctx.accounts.clear();
  ctx.groups.clear();
  ctx.invites.clear();
  ctx.messages.length = 0;
  ctx.sendCalls.length = 0;
  ctx.media.clear();
  ctx.events.length = 0;
  ctx.eventSeq = 0;
}

export function nowMs(ctx: GatewayContext): number {
  return ctx.clock.now().getTime();
}
