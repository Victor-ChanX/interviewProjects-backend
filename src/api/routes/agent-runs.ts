// Agent run 查询端点（题目 2.3 `GET /api/agent-runs/:id` / `GET /api/groups/:id/agent-runs`；issue #13；
// 全局列表 `GET /api/agent-runs` 为 #22 控制台改版加的）。
// HTTP 边界：声明路由 + zod schema + 闸门，查询在 src/services/agent-run-service.ts。两个都是读，走 requireUser
// （viewer 可看）。run 不存在 404 AGENT_RUN_NOT_FOUND、群不存在 404 GROUP_NOT_FOUND，由 service throw。
// 两条路径前缀不同（/api/agent-runs 与 /api/groups），所以这里写全路径、注册时不加 prefix。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  AgentRunDetail,
  AgentRunIdParams,
  AgentRunListQuery,
  AgentRunListResponse,
  AgentRunPage,
} from "../../schemas/agent-run.js";
import { GroupIdParams } from "../../schemas/message.js";
import {
  getAgentRun,
  listAgentRuns,
  listAllAgentRuns,
} from "../../services/agent-run-service.js";
import { requireUser } from "../guards.js";

export default async function agentRunRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/agent-runs",
    {
      onRequest: [requireUser],
      schema: {
        summary:
          "全部群的 agent run 列表：可按状态、群筛选，按创建时间倒序游标分页（不含 steps）",
        tags: ["agent-runs"],
        querystring: AgentRunListQuery,
        response: { 200: AgentRunPage },
      },
    },
    async (req) =>
      listAllAgentRuns({
        status: req.query.status,
        groupId: req.query.groupId,
        before: req.query.before,
        limit: req.query.limit,
      }),
  );

  r.get(
    "/api/agent-runs/:id",
    {
      onRequest: [requireUser],
      schema: {
        summary:
          "某次 agent run 的详情：状态、结束原因、summary 与全部步骤（含协议错误步）",
        tags: ["agent-runs"],
        params: AgentRunIdParams,
        response: { 200: AgentRunDetail },
      },
    },
    async (req) => getAgentRun(req.params.id),
  );

  r.get(
    "/api/groups/:id/agent-runs",
    {
      onRequest: [requireUser],
      schema: {
        summary: "某群最近的 agent run 列表（最新在前，不含 steps）",
        tags: ["agent-runs"],
        params: GroupIdParams,
        response: { 200: AgentRunListResponse },
      },
    },
    async (req) => listAgentRuns(req.params.id),
  );
}
