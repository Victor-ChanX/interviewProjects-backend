// 异常中心端点（#22；题目 A2「让操作员看到」）。HTTP 边界：声明路由 + zod schema + 闸门，逻辑在
// src/services/inconsistency-service.ts。读走 requireUser（viewer 可看）；标记已处理是写，走 requireRole("admin")
// （viewer 403）。记录不存在 404 INCONSISTENCY_NOT_FOUND；重复 resolve 幂等 200。
// 写全路径、注册时不加 prefix：prefix + "/" 会在 openapi 里出成带尾斜杠的 /api/inconsistencies/。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  InconsistencyDetail,
  InconsistencyIdParams,
  InconsistencyListQuery,
  InconsistencyPage,
  InconsistencyRead,
} from "../../schemas/inconsistency.js";
import {
  getInconsistency,
  listInconsistencies,
  resolveInconsistency,
} from "../../services/inconsistency-service.js";
import { requireRole, requireUser } from "../guards.js";

export default async function inconsistencyRoutes(
  app: FastifyInstance,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/inconsistencies",
    {
      onRequest: [requireUser],
      schema: {
        summary:
          "异常中心列表：不一致记录按创建时间倒序，可按是否已处理筛选，游标分页（不含 payload）",
        tags: ["inconsistencies"],
        querystring: InconsistencyListQuery,
        response: { 200: InconsistencyPage },
      },
    },
    async (req) =>
      listInconsistencies({
        resolved:
          req.query.resolved === undefined
            ? undefined
            : req.query.resolved === "true",
        before: req.query.before,
        limit: req.query.limit,
      }),
  );

  r.get(
    "/api/inconsistencies/:id",
    {
      onRequest: [requireUser],
      schema: {
        summary: "某条不一致记录的详情（含 payload 原文）",
        tags: ["inconsistencies"],
        params: InconsistencyIdParams,
        response: { 200: InconsistencyDetail },
      },
    },
    async (req) => getInconsistency(req.params.id),
  );

  r.post(
    "/api/inconsistencies/:id/resolve",
    {
      onRequest: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "把一条不一致记录标记为已处理（记录处理人；幂等，重复标记返回原记录）",
        tags: ["inconsistencies"],
        params: InconsistencyIdParams,
        response: { 200: InconsistencyRead },
      },
    },
    // requireUser 通过后 principal 一定有
    async (req) => resolveInconsistency(req.params.id, req.principal!.username),
  );
}
