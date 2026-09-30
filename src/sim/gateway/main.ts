// 消息网关模拟器的独立进程入口：npm run sim:gateway（端口 SIM_GATEWAY_PORT，默认 8100）。
// 不连库、不启 worker —— 它模拟的是题目 2.1 的外部网关。
import { config } from "../../core/config.js";
import { logger } from "../../core/logger.js";
import { buildGatewayApp } from "./app.js";

async function main(): Promise<void> {
  const port = config.simGatewayPort;
  const app = await buildGatewayApp({
    logger: true,
    publicUrl: `http://localhost:${port}`,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "网关模拟器收到停机信号");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "网关模拟器已启动（场景端点 /_sim/*，事件流 /events）");
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "网关模拟器启动失败");
  process.exit(1);
});
