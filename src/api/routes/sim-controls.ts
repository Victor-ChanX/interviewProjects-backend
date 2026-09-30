// 演示用模拟控制端点（后端 #46）。HTTP 边界：声明路由 + zod schema + 闸门，不写查询、不 import src/db。
// 读开关走 requireUser（控制台据此决定显不显示入口），代推外部发言走 requireRole("admin")（viewer 403，A0）。
//
// 客户端从哪来：插件选项 { simControl }（buildApp({ simControl }) 透传；测试把 src/sim/gateway 起在 listen(0) 上后
// createSimControlClient({ baseUrl }) 注入，传 null 表示开关关着），没给则 simControlClientFromConfig()。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { GroupIdParams } from "../../schemas/message.js";
import {
  SimControlsRead,
  SimulateInboundRequest,
  SimulateInboundResponse,
} from "../../schemas/sim-control.js";
import {
  getSimControls,
  type SimControlClient,
  simControlClientFromConfig,
  simulateInbound,
} from "../../services/sim-control-service.js";
import { requireRole, requireUser } from "../guards.js";

export type SimControlRoutesOptions = {
  simControl?: SimControlClient | null;
};

export default async function simControlRoutes(
  app: FastifyInstance,
  opts: SimControlRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const client =
    opts.simControl !== undefined
      ? opts.simControl
      : simControlClientFromConfig();

  r.get(
    "/api/sim-controls",
    {
      onRequest: [requireUser],
      schema: {
        summary: "演示用模拟控制是否打开（SIM_CONTROLS_ENABLED）",
        tags: ["sim"],
        response: { 200: SimControlsRead },
      },
    },
    async () => getSimControls(client),
  );

  r.post(
    "/api/groups/:id/simulate-inbound",
    {
      onRequest: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "演示用：以外部成员身份往群里推一条消息（经网关模拟器，随后照常进入时间线并可触发 Agent）",
        tags: ["sim"],
        params: GroupIdParams,
        body: SimulateInboundRequest,
        response: { 202: SimulateInboundResponse },
      },
    },
    async (req, reply) => {
      const result = await simulateInbound(req.params.id, req.body, {
        client,
        log: req.log,
      });
      return reply.code(202).send(result);
    },
  );
}
