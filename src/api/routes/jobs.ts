// 异步任务端点（题目 2.3 `GET /api/jobs/:jobId`；issue #11 建群、#16 leave-all 共用）。HTTP 边界：声明路由 +
// zod schema + 闸门，不写查询。读走 requireUser（viewer 可看）；不存在 404 JOB_NOT_FOUND（service throw）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { JobIdParams, JobRead } from "../../schemas/job.js";
import { getJob } from "../../services/group-service.js";
import { requireUser } from "../guards.js";

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/:jobId",
    {
      preHandler: [requireUser],
      schema: {
        summary: "查异步任务（建群 / leave-all）的状态与失败步骤",
        tags: ["jobs"],
        params: JobIdParams,
        response: { 200: JobRead },
      },
    },
    async (req) => getJob(req.params.jobId),
  );
}
