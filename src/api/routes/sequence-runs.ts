// 序列运行端点（题目 2.3 `POST /api/groups/:id/sequence-runs`、`GET /api/sequence-runs/:id`；issue #15）。
// HTTP 边界：声明路由 + zod schema + 闸门，查询与状态机在 src/services/sequence-service.ts。
// 启动走 requireRole("admin")（viewer 403），读走 requireUser。两条路径前缀不同，这里写全路径、注册时不加 prefix。
// 拒绝都由 service throw，信封由 src/app.ts 统一产出：群不存在 404 GROUP_NOT_FOUND、群不可写 409 GROUP_UNREACHABLE、
// 序列不存在 422 SEQUENCE_NOT_FOUND、预检 422 UNRESOLVED_PLACEHOLDER { stepIndex, key }、
// 同群已有 running 409 SEQUENCE_ALREADY_RUNNING、运行不存在 404 SEQUENCE_RUN_NOT_FOUND。
// 201 只保证 run 与步骤已落库：发送由 src/workers/sequence-worker.ts 按步骤的 scheduledAt 推进。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { GroupIdParams } from "../../schemas/group.js";
import {
  SequenceRunIdParams,
  SequenceRunRead,
  SequenceRunStarted,
  StartSequenceRunRequest,
} from "../../schemas/sequence.js";
import { getRun, startRun } from "../../services/sequence-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function sequenceRunRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/groups/:id/sequence-runs",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "在某群启动一次序列运行（预检取值链；同群至多一个 running；201 后由 worker 按排期发送）",
        tags: ["sequences"],
        params: GroupIdParams,
        body: StartSequenceRunRequest,
        response: { 201: SequenceRunStarted },
      },
    },
    async (req, reply) => {
      const { runId } = await startRun(req.params.id, req.body, {
        log: req.log,
      });
      return reply.code(201).send({ runId });
    },
  );

  r.get(
    "/api/sequence-runs/:id",
    {
      preHandler: [requireUser],
      schema: {
        summary: "某次序列运行的状态与每步的取值 / 排期 / 发送结果",
        tags: ["sequences"],
        params: SequenceRunIdParams,
        response: { 200: SequenceRunRead },
      },
    },
    async (req) => getRun(req.params.id),
  );
}
