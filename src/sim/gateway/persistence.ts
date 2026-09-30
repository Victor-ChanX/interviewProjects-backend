// 网关模拟器的状态落盘（后端 #49）。题目 2.1 的网关「保留全部历史事件」、eventId 全局单调递增；内存实现一重启
// （Dokploy 每次重新部署都会重建容器）就把账号、群、消息和事件计数全丢了，而后端库里还记着账号在线、群正常、见过的
// 最大 eventId —— 旧群发不了消息，新事件的 eventId 比后端游标小、被当成已处理丢掉。
//
// 做法：设了 stateFile 就在启动时从文件恢复，之后每 FLUSH_INTERVAL_MS 看一次状态有没有变、变了整份写回
// （临时文件 + rename，读者看不到半个文件），停机前再写一次。不设 = 纯内存（测试与本地默认）。
//
// 持久化：账号、群（成员 / 管理员 / 群主是否已退）、邀请、消息、事件历史与计数、媒体。
// 不持久化：进行中的定时器（504 后延时落地、join 后延时推 member_joined …）与场景脚本 —— 重启回到默认场景；
// pendingJoins 跟着定时器一起丢（恢复成空），否则那几个成员会永远卡在「已受理未入群」。
// 调用记录（sendCalls / promoteCalls / leaveCalls）是给测试断言用的，不落盘。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type {
  Account,
  GatewayContext,
  GatewayEvent,
  Invite,
  Member,
  StoredMessage,
} from "./state.js";

const STATE_VERSION = 1;

/** 多久看一次状态有没有变（变了才写） */
export const FLUSH_INTERVAL_MS = 500;

type PersistedGroup = {
  groupId: string;
  ownerAccountId: string;
  ownerPlatformUserId: string;
  ownerLeft: boolean;
  writeForbidden: boolean;
  members: Member[];
};

type PersistedState = {
  version: number;
  eventSeq: number;
  accounts: Account[];
  groups: PersistedGroup[];
  invites: Invite[];
  messages: StoredMessage[];
  events: GatewayEvent[];
  media: {
    id: string;
    contentType: string;
    base64: string;
    expiresAt: number | null;
  }[];
};

export function serializeState(ctx: GatewayContext): string {
  const state: PersistedState = {
    version: STATE_VERSION,
    eventSeq: ctx.eventSeq,
    accounts: [...ctx.accounts.values()],
    groups: [...ctx.groups.values()].map((g) => ({
      groupId: g.groupId,
      ownerAccountId: g.ownerAccountId,
      ownerPlatformUserId: g.ownerPlatformUserId,
      ownerLeft: g.ownerLeft,
      writeForbidden: g.writeForbidden,
      members: [...g.members.values()],
    })),
    invites: [...ctx.invites.values()],
    messages: ctx.messages,
    events: ctx.events,
    media: [...ctx.media.values()].map((m) => ({
      id: m.id,
      contentType: m.contentType,
      base64: m.bytes.toString("base64"),
      expiresAt: m.expiresAt,
    })),
  };
  return JSON.stringify(state);
}

/** 把落盘的状态灌回一个刚建好的（空）上下文。文件不是本版本的格式直接抛错：带着认不出的状态继续跑比启动失败贵。 */
export function restoreState(ctx: GatewayContext, raw: string): void {
  const state = JSON.parse(raw) as PersistedState;
  if (state.version !== STATE_VERSION) {
    throw new Error(
      `网关模拟器状态文件版本 ${String(state.version)} 与当前 ${STATE_VERSION} 不符：删掉状态文件（同时重置后端库）后重启`,
    );
  }
  ctx.eventSeq = state.eventSeq;
  for (const a of state.accounts) ctx.accounts.set(a.accountId, a);
  for (const g of state.groups) {
    ctx.groups.set(g.groupId, {
      ...g,
      members: new Map(g.members.map((m) => [m.platformUserId, m])),
      pendingJoins: new Set(),
    });
  }
  for (const i of state.invites) ctx.invites.set(i.inviteLink, i);
  ctx.messages.push(...state.messages);
  ctx.events.push(...state.events);
  for (const m of state.media) {
    ctx.media.set(m.id, {
      id: m.id,
      contentType: m.contentType,
      bytes: Buffer.from(m.base64, "base64"),
      expiresAt: m.expiresAt,
    });
  }
}

export type StatePersister = {
  /** 状态变了才写；返回是否写了 */
  flush(): boolean;
  stop(): void;
};

/** 启动时恢复（文件存在的话），之后按间隔落盘。调用方在停机时 stop() 再 flush() 一次。 */
export function attachStateFile(
  ctx: GatewayContext,
  file: string,
): StatePersister {
  let last = "";
  if (existsSync(file)) {
    last = readFileSync(file, "utf8");
    restoreState(ctx, last);
  }
  const flush = (): boolean => {
    const next = serializeState(ctx);
    if (next === last) return false;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, file);
    last = next;
    return true;
  };
  const handle = setInterval(flush, FLUSH_INTERVAL_MS);
  handle.unref();
  return {
    flush,
    stop: () => clearInterval(handle),
  };
}
