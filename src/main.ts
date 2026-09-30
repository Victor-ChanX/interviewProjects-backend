// 入口：迁移（子进程 prisma migrate deploy，自带 advisory lock）→ schema 门 → 种子 → 启 worker → listen；
// SIGTERM 优雅停机。
import { buildApp } from "./app.js";
import { systemClock } from "./core/clock.js";
import { config } from "./core/config.js";
import { logger } from "./core/logger.js";
import {
  assertSchemaCurrent,
  closeDb,
  getDb,
  runMigrations,
} from "./db/client.js";
import { seedDatabase } from "./db/seed.js";
import { startExampleWorker } from "./workers/example-worker.js";

async function main(): Promise<void> {
  runMigrations();
  await assertSchemaCurrent();
  await seedDatabase(getDb(), logger);

  const app = await buildApp();
  const worker = startExampleWorker({
    clock: systemClock,
    intervalMs: 30_000,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "收到停机信号，开始优雅停机");
    await worker.stop();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "启动失败");
  process.exit(1);
});
