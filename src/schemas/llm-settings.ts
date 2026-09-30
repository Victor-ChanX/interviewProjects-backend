// LLM 设置（#19，题目 C2：控制台配置 llm-agent 的上游）的 zod schema。
// 后端只做代理：数据在 llm-agent 的配置文件里，这里的形状与它的 /admin/* 一一对应，多一个 supported。
// 服务商只有题目 C2 点名的 Claude（anthropic）与 Gemini（gemini），各走官方端点，没有端点地址可配。
// API key 只进不出：请求里可以带 apiKey，响应里只有 hasApiKey + apiKeyHint（前 3 后 4）。
import { z } from "zod";

/** 上游服务商：anthropic = Claude，gemini = Gemini */
export const LlmProvider = z
  .enum(["anthropic", "gemini"])
  .meta({ id: "LlmProvider" });
export type LlmProvider = z.infer<typeof LlmProvider>;

/** 配置从哪来：file = 控制台保存过；none = 还没配置 */
export const LlmConfigSource = z
  .enum(["file", "none"])
  .meta({ id: "LlmConfigSource" });
export type LlmConfigSource = z.infer<typeof LlmConfigSource>;

/**
 * GET / PUT /api/llm/settings 的响应。supported=false：AGENT_URL 指向的不是 llm-agent（例如 Agent 模拟器），
 * 或后端没配 LLM_AGENT_ADMIN_TOKEN —— 此时其余字段为 null / false。
 */
export const LlmSettingsRead = z
  .object({
    supported: z.boolean(),
    provider: LlmProvider.nullable(),
    model: z.string().nullable(),
    /** null = 审计与对话用同一个模型 */
    auditModel: z.string().nullable(),
    hasApiKey: z.boolean(),
    /** 形如 `sk-…abcd`；没有 key 为 null */
    apiKeyHint: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
    source: LlmConfigSource.nullable(),
  })
  .meta({ id: "LlmSettingsRead" });
export type LlmSettingsRead = z.infer<typeof LlmSettingsRead>;

const ApiKey = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("省略时沿用已保存的 key —— 仅当 provider 与已保存的相同");

export const LlmSettingsUpdate = z
  .object({
    provider: LlmProvider,
    apiKey: ApiKey,
    model: z.string().trim().min(1),
    /** 省略或 null = 同 model */
    auditModel: z.string().trim().min(1).nullable().optional(),
  })
  .meta({ id: "LlmSettingsUpdate" });
export type LlmSettingsUpdate = z.infer<typeof LlmSettingsUpdate>;

export const LlmModelsRequest = z
  .object({ provider: LlmProvider, apiKey: ApiKey })
  .meta({ id: "LlmModelsRequest" });
export type LlmModelsRequest = z.infer<typeof LlmModelsRequest>;

export const LlmModelRead = z
  .object({
    /** 保存设置时填进 model / auditModel 的值 */
    id: z.string(),
    /** 服务商给的展示名（没有时等于 id） */
    displayName: z.string(),
  })
  .meta({ id: "LlmModelRead" });
export type LlmModelRead = z.infer<typeof LlmModelRead>;

/**
 * 短列表形状 { items, total }，不分页，顺序同服务商返回（新的在前）。只列本服务用得上的模型：
 * Claude 要支持 adaptive 思考、low effort 与结构化输出；Gemini 要支持 generateContent。
 */
export const LlmModelListResponse = z
  .object({ items: z.array(LlmModelRead), total: z.number().int() })
  .meta({ id: "LlmModelListResponse" });
export type LlmModelListResponse = z.infer<typeof LlmModelListResponse>;

/** 测试连接的结果：失败也是 200（ok=false + message），因为「连不通」正是这个操作要报告的结论 */
export const LlmTestResult = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().int(),
    /** 测的是哪个模型；还没配置为 null */
    model: z.string().nullable(),
    message: z.string(),
  })
  .meta({ id: "LlmTestResult" });
export type LlmTestResult = z.infer<typeof LlmTestResult>;
