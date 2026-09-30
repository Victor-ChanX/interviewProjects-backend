// buildApp()：swagger / zod provider / 错误信封 / 路由插件。
// 这里不连数据库：地图与 openapi 脚本会在 PROJECT_MAP_BUILD=1 下 import 本文件。
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
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

import exampleRoutes from "./api/routes/example.js";
import healthRoutes from "./api/routes/health.js";
import { DomainError, type ErrorCode } from "./core/errors.js";
// 副作用 import：让 .meta({ id }) 的 schema 在 app.swagger() 之前已进 z.globalRegistry
import "./schemas/example.js";
import "./schemas/health.js";

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
};

export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger !== false,
    // 不自动给 GET 配 HEAD：让 onRoute 收到的路由与 openapi 的 paths×methods 一一对应
    exposeHeadRoutes: false,
  }).withTypeProvider<ZodTypeProvider>();

  if (opts.onRoute) {
    app.addHook("onRoute", opts.onRoute);
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCors, { origin: true });
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
    if (hasZodFastifySchemaValidationErrors(err)) {
      envelope(422, "VALIDATION_ERROR", "请求参数不合法", {
        issues: err.validation.map((v) => ({
          path: v.instancePath,
          message: v.message,
        })),
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
  void app.register(exampleRoutes, { prefix: "/api/examples" });

  return app;
}
