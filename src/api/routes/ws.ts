// WS /ws（题目 2.3；issue #9 / #18）。HTTP 边界：升级连接、解析客户端帧、验 token；推送逻辑在 src/services/ws-hub.ts。
//
// 协议：连接后第一帧必须是 `{ type: "auth", accessToken, sinceSeq? }`：
//   通过 → `{ type: "auth", success: true }`，之后收事件帧 `{ seq, type, payload }`（带 sinceSeq 先补发 seq > sinceSeq 的）；
//   失败 → `{ type: "auth", success: false, code: "UNAUTHORIZED" }` 并关闭（close code 4401）；
//   认证前 5 秒没收到 auth 帧 → 关闭（hub 按注入时钟在 pump 里判，这里不起定时器）。
// 心跳：`{ type: "ping" }` → `{ type: "pong" }`。认证后的未知帧忽略。
//
// 为什么没有 preHandler 闸门：WebSocket 的浏览器客户端不能带 Authorization 头，凭证只能放在第一帧里，
// PUBLIC_ENDPOINTS（认证在帧里做，闸门函数看不到）。不在 swagger 里（schema.hide）：openapi 描述不了 WS 帧。
import type { FastifyInstance } from "fastify";

import { verifyAccessToken } from "../../core/jwt.js";
import { WsClientFrame } from "../../schemas/ws.js";
import { isSessionActive } from "../../services/auth-service.js";
import type { WsHub, WsSink } from "../../services/ws-hub.js";

export type WsRoutesOptions = {
  hub: WsHub;
};

/**
 * @fastify/websocket 交给 handler 的是 ws 包的 WebSocket；本仓没装 @types/ws（少一个 owner 决定），
 * 它的类型落成 any。这里只声明用到的那几个成员，handler 里立刻收窄成它，别让 any 往下漏。
 */
type ServerSocket = WsSink & {
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** 认证失败 / 未认证就发别的帧时的应用级 close code（与 hub 的认证超时 4401 同一个） */
export const WS_CLOSE_UNAUTHORIZED = 4401;

function rawToText(raw: unknown): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) {
    return Buffer.concat(
      raw.filter((b): b is Buffer => Buffer.isBuffer(b)),
    ).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return "";
}

export default async function wsRoutes(
  app: FastifyInstance,
  opts: WsRoutesOptions,
): Promise<void> {
  app.get(
    "/ws",
    {
      websocket: true,
      schema: {
        hide: true,
        summary:
          "WebSocket 事件推送：第一帧 auth（accessToken, sinceSeq?），之后 { seq, type, payload }",
        tags: ["ws"],
      },
    },
    (rawSocket, req) => {
      const socket = rawSocket as ServerSocket;
      const conn = opts.hub.attach(socket);
      // 同一连接的 auth 帧串行：验 token 与查水位是 async，期间再来一帧不重复认证
      let authenticating = false;

      const send = (frame: unknown): void => {
        socket.send(JSON.stringify(frame));
      };
      const reject = (): void => {
        opts.hub.detach(conn);
        send({ type: "auth", success: false, code: "UNAUTHORIZED" });
        socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      };

      const onMessage = async (raw: unknown): Promise<void> => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawToText(raw));
        } catch {
          parsed = undefined;
        }
        const frame = WsClientFrame.safeParse(parsed);

        if (!conn.authenticated) {
          if (authenticating) return;
          if (!frame.success || frame.data.type !== "auth") {
            reject();
            return;
          }
          authenticating = true;
          const result = verifyAccessToken(frame.data.accessToken);
          if (!result.ok) {
            req.log.info({ reason: result.reason }, "WebSocket 认证失败");
            reject();
            return;
          }
          // 与 requireUser 同一条规则（#17）：logout / 复用作废后的 access token 也不能开 WS
          if (!(await isSessionActive(result.claims.sessionId))) {
            req.log.info({ reason: "session_revoked" }, "WebSocket 认证失败");
            reject();
            return;
          }
          const { resync } = await opts.hub.authenticate(conn, {
            sinceSeq: frame.data.sinceSeq,
          });
          req.log.info(
            {
              userId: result.claims.userId,
              sinceSeq: frame.data.sinceSeq ?? null,
              resync,
            },
            "WebSocket 已认证",
          );
          return;
        }

        if (!frame.success) return;
        if (frame.data.type === "ping") send({ type: "pong" });
      };

      socket.on("message", (raw) => {
        onMessage(raw).catch((err: unknown) => {
          req.log.error({ err }, "处理 WebSocket 帧失败");
          opts.hub.detach(conn);
          socket.close(1011, "internal error");
        });
      });
      socket.on("close", () => opts.hub.detach(conn));
      socket.on("error", (err) => {
        req.log.warn({ err }, "WebSocket 连接出错");
        opts.hub.detach(conn);
      });
    },
  );
}
