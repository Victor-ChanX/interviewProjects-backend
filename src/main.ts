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
import { gatewayClientFromConfig } from "./services/gateway-client.js";
import { createWsHub } from "./services/ws-hub.js";
import { applyGatewayDelivery } from "./services/outbox-service.js";
import { startInboundWorker } from "./workers/inbound-worker.js";
import { defaultWorkerId, startOutboxWorker } from "./workers/outbox-worker.js";
import { startRateLimitWorker } from "./workers/rate-limit-worker.js";
import { startWsBroadcastWorker } from "./workers/ws-broadcast-worker.js";

async function main(): Promise<void> {
  runMigrations();
  await assertSchemaCurrent();
  // 种子在迁移之后、listen 之前：幂等，多副本同时启动也安全
  await seedDatabase(getDb(), logger);

  // WebSocket 推送（#9）：hub 交给 WS 路由登记连接，ws-broadcast-worker 每 200ms 轮询 ws_events 推给它们
  const wsHub = createWsHub({ clock: systemClock });
  const gateway = gatewayClientFromConfig();
  const app = await buildApp({ wsHub, gateway });
  // 出站 outbox（#7）：排期在 messages.nextAttemptAt / unknownSince，这里每 500ms 看一眼
  // （A2：收到 504 起 5 秒内定态 → 2s 确认 + 同 tick 重发，间隔必须 ≤ 500ms）
  const outboxWorker = startOutboxWorker({
    clock: systemClock,
    gateway,
    workerId: defaultWorkerId(),
    intervalMs: 500,
  });
  // 限流到期恢复（#6）：排期在 accounts.rateLimitedUntil，这里只是每秒看一眼
  const rateLimitWorker = startRateLimitWorker({
    clock: systemClock,
    intervalMs: 1_000,
  });
  // 入站 SSE（#8）：游标在 event_cursor，断线 / 重启都带 since 补拉。
  // message_sent / message_failed 的记账走 #7 的 outbox-service.applyGatewayDelivery（这里注入）。
  const inboundWorker = startInboundWorker({
    clock: systemClock,
    gateway,
    applyGatewayDelivery,
  });
  const wsBroadcastWorker = startWsBroadcastWorker({
    hub: wsHub,
    pollIntervalMs: 200,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "收到停机信号，开始优雅停机");
    await Promise.all([
      outboxWorker.stop(),
      rateLimitWorker.stop(),
      inboundWorker.stop(),
      wsBroadcastWorker.stop(),
    ]);
    // 先关 WS 连接再关 HTTP：客户端收到 1001 后按 sinceSeq 重连到别的副本
    await wsHub.stop();
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
