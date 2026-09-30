// 群端点（题目 2.3 `POST /api/groups`、`GET /api/groups`、`GET /api/groups/:id`、`PATCH /api/groups/:id`；issue #11）。
// HTTP 边界：声明路由 + zod schema + 闸门，不写查询、不 import src/db。读走 requireUser（viewer 可看），
// 写（建群 / 开关）走 requireRole("admin")：viewer 403（A0）。
//
// POST 返回 202 { jobId }：groups 行与 create_group job 已落库，网关建群 / 邀请 / join / promote 由
// src/workers/job-worker.ts 按 src/services/group-job-service.ts 的状态机做，进度在 GET /api/jobs/:jobId。
// 拒绝：形状错（≥ 1 个成员、不含群主、不重复）400 VALIDATION_ERROR（zod）、账号不 online 422 ACCOUNT_NOT_ONLINE、
// 群不存在 404 GROUP_NOT_FOUND —— 都由 service throw，信封由 src/app.ts 统一产出。
// POST /:id/leave-all（#16）同样 202 { jobId }：leave_all job 落库，由同一个 worker 按「非群主先、群主最后」退；
// 拒绝：404 GROUP_NOT_FOUND / 409 GROUP_ALREADY_LEFT / 409 GROUP_NOT_READY / 409 JOB_ALREADY_RUNNING。
// 同前缀的 /:id/messages（#9）与 /:id/send（#7）在各自的路由文件里。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  CreateGroupRequest,
  CreateGroupResponse,
  GroupIdParams,
  GroupList,
  GroupRead,
  LeaveAllResponse,
  PatchGroupRequest,
} from "../../schemas/group.js";
import {
  createGroupJob,
  createLeaveAllJob,
  getGroup,
  listGroups,
  patchGroup,
} from "../../services/group-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function groupRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "建群 + 拉人 + 提升 memberAccountIds[0] 为管理员（异步 job，202）",
        tags: ["groups"],
        body: CreateGroupRequest,
        response: { 202: CreateGroupResponse },
      },
    },
    async (req, reply) => {
      const { jobId } = await createGroupJob(req.body, { log: req.log });
      return reply.code(202).send({ jobId });
    },
  );

  r.get(
    "/",
    {
      // 只注册 /api/groups（不带斜杠），让 onRoute 与 openapi 的路径一一对应
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser],
      schema: {
        summary: "列出全部群（含成员与进行中的运行）",
        tags: ["groups"],
        response: { 200: GroupList },
      },
    },
    async () => listGroups(),
  );

  r.get(
    "/:id",
    {
      preHandler: [requireUser],
      schema: {
        summary: "群详情：成员、开关、进行中的运行",
        tags: ["groups"],
        params: GroupIdParams,
        response: { 200: GroupRead },
      },
    },
    async (req) => getGroup(req.params.id),
  );

  r.patch(
    "/:id",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "改群开关 agentEnabled / autoKickEnabled",
        tags: ["groups"],
        params: GroupIdParams,
        body: PatchGroupRequest,
        response: { 200: GroupRead },
      },
    },
    async (req) => patchGroup(req.params.id, req.body, { log: req.log }),
  );

  r.post(
    "/:id/leave-all",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "群里所有服务账号退群：非群主先、群主最后（异步 job，202）",
        tags: ["groups"],
        params: GroupIdParams,
        response: { 202: LeaveAllResponse },
      },
    },
    async (req, reply) => {
      const { jobId } = await createLeaveAllJob(req.params.id, {
        log: req.log,
      });
      return reply.code(202).send({ jobId });
    },
  );
}
