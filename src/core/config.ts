// 唯一允许读 process.env 的地方（eslint no-restricted-syntax 在其他文件拦）。
// 为什么集中：环境变量散落各处会让「哪些配置影响行为」无法一眼看全，
// 也让测试无法用注入替代。这里读一次、校验一次、导出冻结对象。

export type Config = {
  /** HTTP 监听端口 */
  port: number;
  /** PostgreSQL 连接串；生成地图 / 导 openapi 时可以没有 */
  databaseUrl: string | undefined;
  /**
   * 消息网关（题目 2.1）的 base url，如 http://localhost:8100。调网关的 service 从
   * src/services/gateway-client.ts 拿客户端；缺了在第一次调网关时报错而不是启动即失败：
   * 模拟器与生成脚本也 import 本文件，测试则把假网关的 url 注入进去。
   */
  gatewayUrl: string | undefined;
  /**
   * 生成 project-map / openapi 时由脚本置 "1"：
   * buildApp 不连库、main 不启 worker，保证生成物与环境无关。
   */
  projectMapBuild: boolean;
  /**
   * access token 的 HS256 签名密钥（src/core/jwt.ts）。HTTP 服务必填：buildApp 在非
   * PROJECT_MAP_BUILD 下缺了就拒绝构建；这里不直接抛是因为模拟器（src/sim）也 import 本文件，
   * 它们不签发 token。生成地图 / 导 openapi 时同样允许缺。
   */
  jwtSecret: string | undefined;
  /** Agent 服务模拟器（src/sim/agent，`npm run sim:agent`）的监听端口 */
  simAgentPort: number;
  /** 消息网关模拟器（src/sim/gateway，`npm run sim:gateway`）的监听端口 */
  simGatewayPort: number;
  /**
   * Agent 服务（题目 2.2）的 base url，如 http://localhost:8200（#12）。与 gatewayUrl 同样惰性：
   * 缺了在第一次调 /agent/turn 时报错；测试把模拟器（src/sim/agent，listen(0)）的地址注入 agent worker。
   */
  agentUrl: string | undefined;
  /** /agent/turn 每轮超时（题目 A5：10–15 秒可配），毫秒，默认 12000 */
  agentTurnTimeoutMs: number;
  /** /agent/audit 单次超时（题目没规定；审计最多 3 次、耗时计入 60 秒预算，所以不能太长），毫秒，默认 5000 */
  agentAuditTimeoutMs: number;
  /**
   * refresh token cookie 是否带 Secure（issue #17）。NODE_ENV=production 时为 true：生产走 HTTPS，
   * 浏览器对 Secure cookie 只在 https 下回传；本地 http 开发与测试不带，否则 cookie 根本存不进去。
   * 想在非 production 下也开（例如预发环境）设 COOKIE_SECURE=1。
   */
  cookieSecure: boolean;
  /** 真实 LLM 版 Agent 服务（src/llm-agent，`npm run llm-agent`，题目 C2）的监听端口，默认 8300 */
  llmAgentPort: number;
  /**
   * llm-agent 管理端点（/admin/*）的令牌：请求头 x-admin-token 必须等于它。llm-agent 启动时必填；
   * 后端用它调这些端点（控制台的 /api/llm/*），缺了后端把 LLM 设置视为不支持。
   * 上游（base url / key / 模型）不走 env：只来自控制台保存的配置文件（llmAgentConfigFile）。
   */
  llmAgentAdminToken: string | undefined;
  /** 控制台保存的 LLM 配置文件（含 API key，写入时 chmod 600，不进 git / 镜像）；默认启动目录（仓库根）下的 .llm-agent.json */
  llmAgentConfigFile: string;
  /**
   * 一次 /agent/turn 调上游的**总**时长上限（含 429 / 5xx 的重试与退避），毫秒，默认 10000。
   * 必须小于后端的 agentTurnTimeoutMs（AGENT_TURN_TIMEOUT_MS，默认 12000）：否则后端先超时记 TURN_TIMEOUT，
   * 本服务还在重试，答案到了也被丢弃。留 1–2 秒给本服务自身与网络。
   */
  llmTimeoutMs: number;
};

function readMs(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 不是合法的毫秒数：${raw}`);
  }
  return n;
}

function readPort(raw: string | undefined, fallback = 3000): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PORT 不是合法端口：${raw}`);
  }
  return n;
}

export const config: Readonly<Config> = Object.freeze({
  port: readPort(process.env.PORT),
  simAgentPort: readPort(process.env.SIM_AGENT_PORT, 8200),
  simGatewayPort: readPort(process.env.SIM_GATEWAY_PORT, 8100),
  databaseUrl: process.env.DATABASE_URL || undefined,
  gatewayUrl: process.env.GATEWAY_URL || undefined,
  jwtSecret: process.env.JWT_SECRET || undefined,
  projectMapBuild: process.env.PROJECT_MAP_BUILD === "1",
  agentUrl: process.env.AGENT_URL || undefined,
  agentTurnTimeoutMs: readMs(
    process.env.AGENT_TURN_TIMEOUT_MS,
    "AGENT_TURN_TIMEOUT_MS",
    12_000,
  ),
  agentAuditTimeoutMs: readMs(
    process.env.AGENT_AUDIT_TIMEOUT_MS,
    "AGENT_AUDIT_TIMEOUT_MS",
    5_000,
  ),
  cookieSecure:
    process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1",
  llmAgentPort: readPort(process.env.LLM_AGENT_PORT, 8300),
  llmAgentAdminToken: process.env.LLM_AGENT_ADMIN_TOKEN || undefined,
  llmAgentConfigFile: process.env.LLM_AGENT_CONFIG_FILE || ".llm-agent.json",
  llmTimeoutMs: readMs(process.env.LLM_TIMEOUT_MS, "LLM_TIMEOUT_MS", 10_000),
});
