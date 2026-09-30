// 事件流：全局递增的 eventId、全部历史、SSE 订阅者，以及 at-least-once / 乱序的投递语义。
//
// 帧格式（题目 2.1）：`id: <eventId>\nevent: <type>\ndata: <JSON>\n\n`，data 里同时带 eventId 与 type。
// 投递：每个事件按 scenario.events.duplicates 推 N 次；reorderWindowMs > 0 时每次投递随机延迟
// 0–N ms（≤ 1s），所以相邻事件可能乱序。带 since 连接时先按序回放 eventId > since 的历史（回放不重复、
// 不乱序），再接上实时。历史保存在 ctx.events 里，永不清理（reset 除外）。
import type { ServerResponse } from "node:http";

import type {
  EventType,
  GatewayContext,
  GatewayEvent,
  Stream,
} from "./state.js";

/** 记一条事件并按场景投递给所有在线 SSE 连接；返回带 eventId 的事件。 */
export function emit(
  ctx: GatewayContext,
  type: EventType,
  payload: Record<string, unknown>,
): GatewayEvent {
  const eventId = ++ctx.eventSeq;
  const event: GatewayEvent = {
    eventId,
    type,
    data: { ...payload, eventId, type },
  };
  ctx.events.push(event);

  const { duplicates, reorderWindowMs } = ctx.scenario.events;
  for (let copy = 0; copy < duplicates; copy++) {
    const delay = reorderWindowMs > 0 ? ctx.rng.int(0, reorderWindowMs) : 0;
    if (delay === 0) broadcast(ctx, event);
    else ctx.timers.schedule(delay, () => broadcast(ctx, event));
  }
  return event;
}

export function formatFrame(event: GatewayEvent): string {
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function broadcast(ctx: GatewayContext, event: GatewayEvent): void {
  for (const stream of ctx.streams) writeFrame(ctx, stream, event);
}

function writeFrame(
  ctx: GatewayContext,
  stream: Stream,
  event: GatewayEvent,
): void {
  if (stream.res.destroyed) {
    ctx.streams.delete(stream);
    return;
  }
  stream.frames += 1;
  const limit = ctx.scenario.events.disconnectAfterFrames;
  if (limit !== null && stream.frames >= limit) {
    // 这一帧先送出去再掐（destroy 会丢掉还没刷到内核的写入）。
    ctx.streams.delete(stream);
    stream.res.write(formatFrame(event), () => stream.res.destroy());
    return;
  }
  stream.res.write(formatFrame(event));
}

/**
 * 把一个已 hijack 的响应接成 SSE 流：写头 → 回放 since 之后的历史 → 登记为订阅者。
 * 回放与登记在同一个同步块里完成，中间不可能插进新事件，所以既不漏也不重。
 */
export function attachStream(
  ctx: GatewayContext,
  res: ServerResponse,
  since: number | null,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const stream: Stream = { res, frames: 0 };
  if (since !== null) {
    for (const event of ctx.events) {
      if (event.eventId > since) writeFrame(ctx, stream, event);
      if (res.destroyed) return;
    }
  }
  ctx.streams.add(stream);
  res.once("close", () => ctx.streams.delete(stream));
}

/** 主动掐断所有 SSE 连接（场景「连接可能随时断开」）。 */
export function disconnectStreams(ctx: GatewayContext): number {
  const n = ctx.streams.size;
  for (const stream of ctx.streams) stream.res.destroy();
  ctx.streams.clear();
  return n;
}
