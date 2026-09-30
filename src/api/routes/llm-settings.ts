// LLM 设置端点（#19，题目 C2：控制台配置 llm-agent 的上游）。HTTP 边界：声明路由 + zod schema + 闸门，
// 代理逻辑在 src/services/llm-settings-service.ts。读走 requireUser（viewer 可看，看不到 key），
// 写 / 列模型 / 测试走 requireRole("admin")：会把 key 发给外部服务、会花钱。
//
// 客户端从哪来：插件选项 { llmAdmin }（buildApp({ llmAdmin }) 透传；测试把 llm-agent 起在 listen(0) 上后注入），
// 没给则 llmAdminClientFromConfig()（AGENT_URL + LLM_AGENT_ADMIN_TOKEN，缺任一为 null = 不支持）。
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  LlmModelListResponse,
  LlmModelsRequest,
  LlmSettingsRead,
  LlmSettingsUpdate,
  LlmTestResult,
} from "../../schemas/llm-settings.js";
import {
  getLlmSettings,
  listLlmModels,
  llmAdminClientFromConfig,
  saveLlmSettings,
  testLlmConnection,
  type LlmAdminClient,
} from "../../services/llm-settings-service.js";
import { requireRole, requireUser } from "../guards.js";

export type LlmSettingsRoutesOptions = {
  /** undefined = 按配置建；null = 明确「不支持」 */
  llmAdmin?: LlmAdminClient | null;
};

export default async function llmSettingsRoutes(
  app: FastifyInstance,
  opts: LlmSettingsRoutesOptions,
): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const client: LlmAdminClient | null =
    opts.llmAdmin !== undefined ? opts.llmAdmin : llmAdminClientFromConfig();

  r.get(
    "/api/llm/settings",
    {
      preHandler: [requireUser],
      schema: {
        summary:
          "当前的 LLM 设置（Base URL、模型、key 提示）；Agent 服务不是 llm-agent 时 supported=false",
        tags: ["llm"],
        response: { 200: LlmSettingsRead },
      },
    },
    async () => getLlmSettings(client),
  );

  r.put(
    "/api/llm/settings",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "保存 LLM 设置（apiKey 省略时仅在 Base URL 不变时沿用已保存的 key），llm-agent 立即生效",
        tags: ["llm"],
        body: LlmSettingsUpdate,
        response: { 200: LlmSettingsRead },
      },
    },
    async (req) => saveLlmSettings(client, req.body),
  );

  r.post(
    "/api/llm/models",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary: "用给定的 Base URL 与 key 向服务商获取模型列表（按 id 排序）",
        tags: ["llm"],
        body: LlmModelsRequest,
        response: { 200: LlmModelListResponse },
      },
    },
    async (req) => listLlmModels(client, req.body),
  );

  r.post(
    "/api/llm/test",
    {
      preHandler: [requireUser, requireRole("admin")],
      schema: {
        summary:
          "用已保存的 LLM 设置测试连接（一轮带工具历史的对话 + 一次审计），失败也返回 200 与原因",
        tags: ["llm"],
        response: { 200: LlmTestResult },
      },
    },
    async () => testLlmConnection(client),
  );
}
