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
};

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
});
