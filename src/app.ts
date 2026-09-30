// buildApp()：swagger / zod provider / 错误信封 / 路由插件。
// 这里不连数据库：地图与 openapi 脚本会在 PROJECT_MAP_BUILD=1 下 import 本文件。
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type onRouteHookHandler,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import accountRoutes from "./api/routes/accounts.js";
import activityRoutes from "./api/routes/activity.js";
import agentRunRoutes from "./api/routes/agent-runs.js";
import authRoutes from "./api/routes/auth.js";
import dashboardRoutes from "./api/routes/dashboard.js";
import groupMessageRoutes from "./api/routes/group-messages.js";
import groupSendRoutes from "./api/routes/group-send.js";
import groupRoutes from "./api/routes/groups.js";
import healthRoutes from "./api/routes/health.js";
import inconsistencyRoutes from "./api/routes/inconsistencies.js";
import jobRoutes from "./api/routes/jobs.js";
import llmSettingsRoutes from "./api/routes/llm-settings.js";
import sequenceRunRoutes from "./api/routes/sequence-runs.js";
import sequenceRoutes from "./api/routes/sequences.js";
import wsRoutes from "./api/routes/ws.js";
import { config } from "./core/config.js";
import { DomainError, type ErrorCode } from "./core/errors.js";
import { assertJwtSecretConfigured } from "./core/jwt.js";
import type { GatewayClient } from "./services/gateway-client.js";
import type { LlmAdminClient } from "./services/llm-settings-service.js";
import { createWsHub, type WsHub } from "./services/ws-hub.js";
// 副作用 import：让 .meta({ id }) 的 schema 在 app.swagger() 之前已进 z.globalRegistry
import "./schemas/account.js";
import "./schemas/activity.js";
import "./schemas/agent-run.js";
import "./schemas/auth.js";
import "./schemas/dashboard.js";
import "./schemas/group.js";
import "./schemas/health.js";
import "./schemas/inconsistency.js";
import "./schemas/job.js";
import "./schemas/llm-settings.js";
import "./schemas/message.js";
import "./schemas/sequence.js";

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    [key: string]: unknown;
  };
};

export type BuildAppOptions = {
  /** false 给测试 / 生成脚本用，避免 pino 往 stdout 写日志 */
  logger?: boolean;
  /**
   * 路由收集钩子（project-map 脚本用）。
   * 为什么放在参数里而不是让调用方事后 addHook：async 函数 return app 时
   * Promise 会解开 Fastify 的 thenable，等于把已注册的插件全部装载完，
   * 之后再挂 onRoute 已经晚了；只有在 register 之前挂上才收得到。
   */
  onRoute?: onRouteHookHandler;
  /**
   * 消息网关客户端（#6）。不给则各路由用 GATEWAY_URL（gatewayClientFromConfig，惰性）。
   * 测试把 src/sim/gateway 起在 listen(0) 上后经这里注入 —— 不能事后 app.decorate：
   * 本函数是 async、返回 Fastify 实例，await 时 thenable 已把路由插件装载完。
   */
  gateway?: GatewayClient;
  /**
   * WebSocket 推送 hub（#9）。src/main.ts 建一个交给这里的 WS 路由，再交给 ws-broadcast-worker 轮询；
   * 测试同样自己建（轮询间隔调小）。不给则建一个没人轮询的 hub：连接能认证，但收不到事件。
   */
  wsHub?: WsHub;
  /**
   * llm-agent 管理端点的客户端（#19，/api/llm/*）。不给则按 AGENT_URL + LLM_AGENT_ADMIN_TOKEN 建（缺任一 = 不支持）；
   * 测试把 llm-agent 起在 listen(0) 上后经这里注入，传 null 表示「不支持」。
   */
  llmAdmin?: LlmAdminClient | null;
};

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  // 必填配置在这里查而不是 config.ts：模拟器（src/sim）也 import config，但只有 HTTP 服务签 token。
  // 生成地图 / 导 openapi 时不签不验，允许缺。
  if (!config.projectMapBuild) assertJwtSecretConfigured();

  const app = Fastify({
    logger: opts.logger !== false,
    // 不自动给 GET 配 HEAD：让 onRoute 收到的路由与 openapi 的 paths×methods 一一对应
    exposeHeadRoutes: false,
    // 网关传了 x-request-id 就沿用（错误信封与日志里的 requestId 都是 request.id），没传才自生成
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  // 响应也带上 requestId：客户端拿着它就能对上服务端日志
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  if (opts.onRoute) {
    app.addHook("onRoute", opts.onRoute);
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCors, { origin: true });
  // refresh token cookie（#17）：解析 request.cookies、提供 reply.setCookie / clearCookie。不签名：值本身是随机 32 字节，
  // 库里只存哈希，签名不增加什么。
  await app.register(fastifyCookie);
  // WS /ws（#9）：升级握手由它接管；路由声明 websocket: true 即可
  await app.register(fastifyWebsocket);
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "fixture-node-api", version: "0.1.0" },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // 唯一产出错误信封的地方。路由里不许手写 reply.code(4xx).send(...)。
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    const envelope = (
      statusCode: number,
      code: ErrorCode,
      message: string,
      extra: Record<string, unknown> = {},
    ): void => {
      const body: ErrorEnvelope = {
        error: { ...extra, code, message, requestId },
      };
      void reply.code(statusCode).send(body);
    };

    if (err instanceof DomainError) {
      envelope(err.statusCode, err.code, err.message, err.extra);
      return;
    }
    // 请求体 / 参数形状错：题目 2.3 约定 400 VALIDATION_ERROR（业务规则不合法仍是 Invalid → 422）
    if (hasZodFastifySchemaValidationErrors(err)) {
      envelope(400, "VALIDATION_ERROR", "请求参数不合法", {
        issues: err.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
      });
      return;
    }
    // Fastify 自己在解析请求体时拒掉的（空 JSON 体、坏 JSON、类型不支持、体积超限）：是调用方的错，不是 500
    if (isFastifyClientError(err)) {
      envelope(err.statusCode, "VALIDATION_ERROR", "请求体不合法", {
        reason: err.code,
      });
      return;
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, requestId }, "响应不符合声明的 schema");
      envelope(500, "INTERNAL", "服务内部错误");
      return;
    }
    req.log.error({ err, requestId }, "未处理的异常");
    envelope(500, "INTERNAL", "服务内部错误");
  });

  // 不 await：路由插件排队到 app.ready() 再装载（onRoute 已在上面挂好）。
  void app.register(healthRoutes);
  void app.register(authRoutes);
  void app.register(accountRoutes, {
    prefix: "/api/accounts",
    gateway: opts.gateway,
  });
  void app.register(groupRoutes, { prefix: "/api/groups" });
  void app.register(groupMessageRoutes, { prefix: "/api/groups" });
  void app.register(groupSendRoutes, { prefix: "/api/groups" });
  void app.register(jobRoutes, { prefix: "/api/jobs" });
  // agent run 查询（#13）：两条路径前缀不同（/api/agent-runs 与 /api/groups/:id/agent-runs），路由文件写全路径
  void app.register(agentRunRoutes);
  // 定时序列（#15）：POST /api/sequences 走 prefix；运行的两条路径前缀不同（/api/groups/:id/sequence-runs 与
  // /api/sequence-runs/:id），路由文件写全路径
  void app.register(sequenceRoutes, { prefix: "/api/sequences" });
  void app.register(sequenceRunRoutes);
  void app.register(wsRoutes, { hub: opts.wsHub ?? createWsHub() });
  // LLM 设置（#19）：代理 llm-agent 的管理端点，路由文件写全路径
  void app.register(
    llmSettingsRoutes,
    opts.llmAdmin !== undefined ? { llmAdmin: opts.llmAdmin } : {},
  );

  // 工作台与监控（#22）：概览计数、异常中心、最近动态；全局 agent run 列表在 agentRunRoutes 里
  void app.register(dashboardRoutes);
  void app.register(inconsistencyRoutes);
  void app.register(activityRoutes);

  return app;
}

/** Fastify 内置的 4xx（FST_ERR_CTP_* 等请求体解析错误），带 statusCode。 */
function isFastifyClientError(
  err: unknown,
): err is { statusCode: number; code: string } {
  if (typeof err !== "object" || err === null) return false;
  const { statusCode, code } = err as { statusCode?: unknown; code?: unknown };
  return (
    typeof statusCode === "number" &&
    statusCode >= 400 &&
    statusCode < 500 &&
    typeof code === "string" &&
    code.startsWith("FST_ERR_")
  );
}
