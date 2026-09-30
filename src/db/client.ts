// 连接池 / PrismaClient 实例 / 迁移。
// 为什么 lazy：生成 project-map、导 openapi 时脚本会 import src/app.ts，
// 那时既没有 DATABASE_URL 也不该碰数据库；Pool 与 PrismaClient 在第一次 getDb() 才建。
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { PrismaClient } from "./generated/client.js";

export type Db = PrismaClient;

/** 迁移链目录（prisma.config.ts 的 migrations.path；assertSchemaCurrent 读它） */
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../prisma/migrations", import.meta.url),
);

let pool: Pool | undefined;
let db: Db | undefined;

/**
 * 连接串里的 `?schema=` 只有 Prisma CLI（migrate）认；pg 的 Pool 会忽略它。
 * 应用侧要落到同一个 schema，得同时做两件事：
 * 1. Pool 连接建立时 `SET search_path`（libpq 的 options 参数）—— 覆盖 $queryRaw 手写 SQL；
 * 2. PrismaPg 的 `{ schema }` —— 查询编译器生成的 SQL 会带上 `"<schema>".` 前缀。
 * 测试的临时 schema（tests/setup.ts）就靠这条：DATABASE_URL 带 ?schema=<tmp>。
 */
function schemaFromUrl(url: string): string | undefined {
  return new URL(url).searchParams.get("schema") ?? undefined;
}

export function getDb(): Db {
  if (db) return db;
  if (config.projectMapBuild) {
    throw new Error("PROJECT_MAP_BUILD=1 时不允许连接数据库");
  }
  if (!config.databaseUrl) {
    throw new Error("缺少 DATABASE_URL");
  }
  const schema = schemaFromUrl(config.databaseUrl);
  pool = new Pool({
    connectionString: config.databaseUrl,
    ...(schema ? { options: `-c search_path="${schema}"` } : {}),
  });
  db = new PrismaClient({
    adapter: new PrismaPg(pool, schema ? { schema } : undefined),
  });
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.$disconnect();
    db = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * 启动时前滚迁移：子进程跑 `prisma migrate deploy`（读 prisma.config.ts 与 DATABASE_URL）。
 * 不自己写迁移执行器：Prisma 的 migrate deploy 自带 advisory lock（多副本同时启动时串行），
 * 并把已应用的记录写进 _prisma_migrations。
 * 为什么用 execFileSync 而不是 npx：镜像里 node_modules/.bin/prisma 一定在，npx 会多一次解析。
 */
export function runMigrations(): void {
  if (config.projectMapBuild) {
    throw new Error("PROJECT_MAP_BUILD=1 时不允许跑迁移");
  }
  const prismaBin = fileURLToPath(
    new URL("../../node_modules/.bin/prisma", import.meta.url),
  );
  const out = execFileSync(prismaBin, ["migrate", "deploy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  logger.info({ out: out.trim().split("\n").at(-1) }, "迁移已前滚到最新");
}

/**
 * schema 落后于代码时拒绝启动：
 * prisma/migrations 下每个迁移目录名都必须在 _prisma_migrations 里且 finished_at 非空
 * （rolled_back_at 为空）。
 * 为什么：迁移没跑就把新代码放出去，会在运行期以奇怪的 SQL 错误暴露，不如启动即失败。
 */
export async function assertSchemaCurrent(): Promise<void> {
  const database = getDb();
  const expected = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (expected.length === 0) return;

  const rows = await database.$queryRaw<{ migration_name: string }[]>`
    select migration_name from _prisma_migrations
    where finished_at is not null and rolled_back_at is null`;
  const applied = new Set(rows.map((r) => r.migration_name));
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new Error(
      `数据库 schema 落后于代码：未应用的迁移 ${missing.join(", ")}（先跑 npm run db:deploy）`,
    );
  }
}
