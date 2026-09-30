// 消息网关模拟器（题目 2.1）：buildGatewayApp(opts) 返回一个独立的 Fastify 实例，
// 测试用 app.inject / 真实 listen 都可以；main.ts 用它起独立进程（npm run sim:gateway）。
//
// 它是「外部服务」：不 import 应用的 src/db / src/services，不走应用的错误信封。
// 错误体统一为 `{ code, message, ...extra }`（见 errors.ts），成功体按题目 2.1 原样
// （`{ platformUserId }`、`{ groupId }`、`202 { accepted: true }`、成员列表是裸数组 …）。
// 场景脚本（每个事件推两次、send 先 504 再落地、429 …）经 /_sim/scenario 注入，见 admin.ts 与 README.md。
import Fastify, { type FastifyInstance } from "fastify";

import { type Clock, systemClock } from "../../core/clock.js";
import { registerAdminRoutes } from "./admin.js";
import { GatewayError } from "./errors.js";
import { disconnectStreams } from "./events.js";
import { attachStateFile } from "./persistence.js";
import { registerGatewayRoutes } from "./routes.js";
import { createContext, createRng, cryptoUnit } from "./state.js";

export type BuildGatewayAppOptions = {
  /** false 给测试用，避免 pino 往 stdout 写日志 */
  logger?: boolean;
  /** 可注入时钟（sentAt、限流截止、邀请就绪 / 过期都从它取「现在」） */
  clock?: Clock;
  /** 可注入随机源：返回 [0, 1)。默认 node:crypto。测试给固定值即可让延时 / 乱序可预测 */
  random?: () => number;
  /** mediaUrl 的前缀，例如 http://localhost:8100；不给则 mediaUrl 是相对路径 /media/:id */
  publicUrl?: string;
  /**
   * 状态文件（#49）：给了就启动时恢复、之后按间隔落盘、关闭时再写一次 —— 重启 / 重新部署不丢账号、群与事件历史。
   * 不给 = 纯内存（测试与本地默认）。见 persistence.ts。
   */
  stateFile?: string;
};

export async function buildGatewayApp(
  opts: BuildGatewayAppOptions = {},
): Promise<FastifyInstance> {
  const ctx = createContext({
    clock: opts.clock ?? systemClock,
    rng: createRng(opts.random ?? cryptoUnit),
    publicUrl: opts.publicUrl ?? "",
  });

  const app = Fastify({
    logger: opts.logger !== false,
    exposeHeadRoutes: false,
  });

  // 空 JSON 体当 {}：connect / disconnect / invite 这类无参 POST，客户端常带 content-type 不带体。
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text) as unknown);
      } catch {
        done(new GatewayError(400, "BAD_REQUEST", "请求体不是合法 JSON"));
      }
    },
  );

  // 整体 503：场景 outage.all 或 outage.routes 命中的端点。/_sim/* 是控制面，不受影响。
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/_sim")) return;
    const { all, routes } = ctx.scenario.outage;
    const key = `${req.method} ${req.routeOptions.url ?? req.url}`;
    if (all || routes.some((r) => key.includes(r))) {
      throw new GatewayError(503, "SERVICE_UNAVAILABLE", "网关暂时不可用");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GatewayError) {
      void reply
        .code(err.statusCode)
        .send({ code: err.code, message: err.message, ...err.extra });
      return;
    }
    // Fastify 自己的 4xx（空 JSON 体、坏 JSON、415 …）：按坏请求回，不当内部错误。
    const { statusCode, message } = err as {
      statusCode?: number;
      message?: string;
    };
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      void reply
        .code(statusCode)
        .send({ code: "BAD_REQUEST", message: message ?? "请求不合法" });
      return;
    }
    req.log.error({ err }, "网关模拟器未处理的异常");
    void reply.code(500).send({ code: "INTERNAL", message: "模拟器内部错误" });
  });

  registerGatewayRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  const persister = opts.stateFile
    ? attachStateFile(ctx, opts.stateFile)
    : null;

  app.addHook("onClose", async () => {
    ctx.timers.clearAll();
    disconnectStreams(ctx);
    persister?.stop();
    persister?.flush();
  });

  return app;
}
