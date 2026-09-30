// 序列定义端点（题目 2.3 `POST /api/sequences`；issue #15）。
// HTTP 边界：声明路由 + zod schema + 闸门，不写查询、不 import src/db。创建走 requireRole("admin")（viewer 403），
// 列表（控制台页面 5「选序列」用）走 requireUser。
// 序列 JSON 的形状（index 从 1 连续、delaySeconds ≥ 0）由 zod 拦成 400 VALIDATION_ERROR；占位符能否解析到
// 是启动时的事（POST /api/groups/:id/sequence-runs，src/api/routes/sequence-runs.ts）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  SequenceCreated,
  SequenceDefinition,
  SequenceList,
} from "../../schemas/sequence.js";
import {
  createSequence,
  listSequences,
} from "../../services/sequence-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function sequenceRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "创建序列定义（题目 B1 的 JSON）",
        tags: ["sequences"],
        body: SequenceDefinition,
        response: { 201: SequenceCreated },
      },
    },
    async (req, reply) => {
      const { id } = await createSequence(req.body, { log: req.log });
      return reply.code(201).send({ id });
    },
  );

  r.get(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser],
      schema: {
        summary: "列出全部序列定义（按创建顺序）",
        tags: ["sequences"],
        response: { 200: SequenceList },
      },
    },
    async () => listSequences(),
  );
}
