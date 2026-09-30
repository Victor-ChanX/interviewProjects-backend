// WS /ws 的帧（题目 2.3；issue #9 / #18）。客户端 → 服务端的帧在路由里用这些 schema 解析；
// 服务端 → 客户端的帧形状见 src/services/ws-hub.ts 头注释（auth / resync / 事件帧 { seq, type, payload }）。
// 端点不在 openapi 里（schema.hide），这里的 schema 不进 z.globalRegistry。
import { z } from "zod";

/** 连接后的第一帧：`{ type: "auth", accessToken, sinceSeq? }`。sinceSeq = 客户端收到的最后一个 seq（断线重连补发） */
export const WsAuthFrame = z.object({
  type: z.literal("auth"),
  accessToken: z.string().min(1),
  sinceSeq: z.number().int().min(0).optional(),
});
export type WsAuthFrame = z.infer<typeof WsAuthFrame>;

/** 心跳：`{ type: "ping" }` → `{ type: "pong" }` */
export const WsPingFrame = z.object({
  type: z.literal("ping"),
});

export const WsClientFrame = z.discriminatedUnion("type", [
  WsAuthFrame,
  WsPingFrame,
]);
export type WsClientFrame = z.infer<typeof WsClientFrame>;
