// HTTP 边界：声明路由 + zod schema + 闸门。不写查询、不 import src/db。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  ExampleCreate,
  ExampleIdParams,
  ExampleListQuery,
  ExampleListResponse,
  ExampleRead,
} from "../../schemas/example.js";
import {
  createExample,
  getExample,
  listExamples,
} from "../../services/example-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function exampleRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/",
    {
      // 只注册 /api/examples（不带斜杠），让 onRoute 与 openapi 的路径一一对应
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser],
      schema: {
        summary: "分页列出示例",
        tags: ["examples"],
        querystring: ExampleListQuery,
        response: { 200: ExampleListResponse },
      },
    },
    async (req) => listExamples(req.query),
  );

  r.get(
    "/:id",
    {
      preHandler: [requireUser],
      schema: {
        summary: "按 id 读取示例",
        tags: ["examples"],
        params: ExampleIdParams,
        response: { 200: ExampleRead },
      },
    },
    async (req) => getExample(req.params.id),
  );

  r.post(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "创建示例",
        tags: ["examples"],
        body: ExampleCreate,
        response: { 201: ExampleRead },
      },
    },
    async (req, reply) => {
      const created = await createExample(req.body);
      reply.code(201);
      return created;
    },
  );
}
