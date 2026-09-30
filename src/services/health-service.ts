// 健康检查的 schemaVersion：prisma/migrations 下按名字排序的最后一个目录名（时间戳前缀，字典序即时间序）。
// 为什么读目录而不是 _prisma_migrations 表：启动时 assertSchemaCurrent()（src/db/client.ts）已经保证
// 目录里的每一条都在库里 finished_at 非空，所以「代码带的最新迁移」= 「库里已应用的最新迁移」；
// 读目录不占连接、库抖动时探活也不跟着 500（探活只回答「进程活着、跑的是哪一版 schema」）。
// 镜像里带 prisma/ 目录（.dockerignore 不排除它），路径相对本文件解析，dist/ 与 src/ 同深度。
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ServiceUnavailable } from "../core/errors.js";
import { assertSchemaCurrent, getDb } from "../db/client.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../prisma/migrations", import.meta.url),
);

export function getSchemaVersion(): string {
  const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const latest = names.at(-1);
  if (!latest) {
    throw new Error("prisma/migrations 下没有任何迁移目录");
  }
  return latest;
}

/** 调度器心跳多久以内算 worker 还活着（心跳每秒一次，见 sequence-service） */
export const READY_HEARTBEAT_MAX_AGE_MS = 10_000;

export type ReadinessChecks = {
  database: "ok" | "fail";
  schema: "ok" | "fail";
  scheduler: "ok" | "fail";
};

/**
 * 就绪检查（后端 #57）：与上面的探活不同，它真的去碰依赖 —— 数据库能查、库的迁移状态与代码一致、后台 worker 在跳
 * 调度器心跳（scheduler_heartbeats，任一副本在跳即可）。有一项不行就 503 NOT_READY，extra.checks 说明是哪项。
 */
export async function checkReadiness(now: Date): Promise<ReadinessChecks> {
  const checks: ReadinessChecks = {
    database: "fail",
    schema: "fail",
    scheduler: "fail",
  };
  try {
    await getDb().$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    throw notReady(checks);
  }
  try {
    await assertSchemaCurrent();
    checks.schema = "ok";
  } catch {
    // 记下后继续看调度器
  }
  const beat = await getDb().schedulerHeartbeat.findFirst({
    orderBy: { beatAt: "desc" },
    select: { beatAt: true },
  });
  if (
    beat &&
    now.getTime() - beat.beatAt.getTime() <= READY_HEARTBEAT_MAX_AGE_MS
  ) {
    checks.scheduler = "ok";
  }
  if (checks.schema !== "ok" || checks.scheduler !== "ok")
    throw notReady(checks);
  return checks;
}

function notReady(checks: ReadinessChecks): ServiceUnavailable {
  const failed = Object.entries(checks)
    .filter(([, v]) => v !== "ok")
    .map(([k]) => k);
  return new ServiceUnavailable(
    "NOT_READY",
    `服务未就绪：${failed.join("、")} 检查未通过`,
    { checks },
  );
}
