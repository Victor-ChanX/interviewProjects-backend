// 账号端点（题目 2.3；issue #6）。HTTP 边界：声明路由 + zod schema + 闸门，不写查询、不 import src/db。
// 读走 requireUser（viewer 可看），写（connect / transition）走 requireRole("admin")：viewer 对所有写操作 403（A0）。
//
// 网关客户端从哪来：插件选项 { gateway }（buildApp({ gateway }) 透传；测试把 src/sim/gateway 起在 listen(0)
// 上后 createGatewayClient({ baseUrl }) 注入），没给则 gatewayClientFromConfig()（GATEWAY_URL，惰性）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  AccountIdParams,
  AccountList,
  AccountRead,
  AccountTransitionRequest,
  AccountTransitionResponse,
} from "../../schemas/account.js";
import {
  connect,
  DEFAULT_RATE_LIMIT_SECONDS,
  listAccounts,
  toAccountRead,
  transition,
  type TransitionResult,
} from "../../services/account-service.js";
import {
  type GatewayClient,
  gatewayClientFromConfig,
} from "../../services/gateway-client.js";
import { requireRole, requireUser } from "../guards.js";

export type AccountRoutesOptions = {
  gateway?: GatewayClient;
};

function toTransitionResponse(result: TransitionResult) {
  return {
    ...toAccountRead(result.account),
    from: result.from,
    changed: result.changed,
    membersRemovedCount: result.cascade.membersRemoved,
    messagesCancelledCount: result.cascade.messagesCancelled,
    stepsSkippedCount: result.cascade.stepsSkipped,
  };
}

export default async function accountRoutes(
  app: FastifyInstance,
  opts: AccountRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const gateway: GatewayClient = opts.gateway ?? gatewayClientFromConfig();

  r.get(
    "/",
    {
      // 只注册 /api/accounts（不带斜杠），让 onRoute 与 openapi 的路径一一对应
      prefixTrailingSlash: "no-slash",
      preHandler: [requireUser],
      schema: {
        summary: "列出全部服务账号及其状态",
        tags: ["accounts"],
        response: { 200: AccountList },
      },
    },
    async () => listAccounts(),
  );

  r.post(
    "/:id/connect",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "调网关 connect，账号 idle / disconnected → online",
        tags: ["accounts"],
        params: AccountIdParams,
        response: { 200: AccountRead },
      },
    },
    async (req) => {
      const result = await connect(req.params.id, {
        gateway,
        log: req.log,
      });
      return toAccountRead(result.account);
    },
  );

  r.post(
    "/:id/transition",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "操作员手动标记账号状态（expectedFrom 做 CAS）",
        tags: ["accounts"],
        params: AccountIdParams,
        body: AccountTransitionRequest,
        response: { 200: AccountTransitionResponse },
      },
    },
    async (req) => {
      const { to, expectedFrom } = req.body;
      const result = await transition(
        req.params.id,
        {
          to,
          expectedFrom,
          source: "operator",
          // 操作员手动标 rate_limited 没有网关给的 retryAfterSeconds，用默认时长；到期由 worker 恢复
          ...(to === "rate_limited"
            ? { rateLimitSeconds: DEFAULT_RATE_LIMIT_SECONDS }
            : {}),
        },
        { gateway, log: req.log },
      );
      return toTransitionResponse(result);
    },
  );
}
