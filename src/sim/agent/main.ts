// Agent 服务模拟器入口：独立进程（`npm run sim:agent`），端口 SIM_AGENT_PORT（默认 8200）。
// 不连数据库、不启 worker；应用侧把 AGENT_URL 指到这里即可。
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import { buildAgentApp } from "./app.js";

async function main(): Promise<void> {
  const app = await buildAgentApp();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Agent 模拟器收到停机信号");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.simAgentPort, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "Agent 模拟器启动失败");
  process.exit(1);
});
