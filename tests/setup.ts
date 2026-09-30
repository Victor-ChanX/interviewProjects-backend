// tests/setup.ts —— 每个测试文件加载前跑一次（vitest.config.mts 的 setupFiles）。做三件事：
//
// 1. 禁外网：undici 的 MockAgent 接管全局 fetch，不在白名单的主机一律抛 MockNotMatchedError。
//    测试里的外部服务用「可编程的假服务」—— 在测试里起一个 fastify 假实例监听 localhost，
//    按用例脚本化返回 202 / 429 / 504 / 重复事件（business-testing rules test.fake-external-service），
//    所以 localhost 放行。
// 2. 临时 schema：每个测试文件一个 `test_<pid>_<随机>` schema，DATABASE_URL 加 `?schema=<tmp>`，
//    子进程跑 `prisma migrate deploy` 把整条迁移链前滚到该 schema（真实 PostgreSQL，不用
//    SQLite / pg-mem / prisma-mock：FOR UPDATE SKIP LOCKED、部分唯一索引、enum、P2002 在假库 /
//    假客户端上都是假绿）。afterAll CASCADE 删掉。
//    为什么是 schema 不是库：建库要超级用户且慢；schema 在同一连接上秒建秒删，CI 只要一个库。
//    `?schema=` 是 Prisma CLI 的约定：migrate deploy 会在该 schema 里建表、枚举与 _prisma_migrations
//    （schema 不存在时 CLI 自己建）。**应用侧不认它**（实测 7.10）：pg 的 Pool 忽略这个参数，
//    PrismaPg 也不解析连接串，查询编译器生成的 SQL 固定带 `"public".` 前缀，连 search_path 都救
//    不了。所以 src/db/client.ts 的 getDb() 从 url 里读出 schema，给 Pool 设
//    `options: -c search_path=<schema>`（盖住 $queryRaw 手写的 SQL）、给 PrismaPg 传 `{ schema }`
//    （盖住查询编译器生成的 SQL），两边才落在同一个 schema 里 —— 本文件只改 DATABASE_URL，
//    不改应用代码；client.ts 少了那两行，这里的测试会读到 public 里的表。
// 3. truncateAll()：各文件 beforeEach 调，清空临时 schema 里所有表（_prisma_migrations 除外）、
//    序列归零。
//
// 为什么 vitest.config.mts 要 fileParallelism: false：schema 能把表隔开，但隔不开库级的东西 ——
// advisory lock 的键（pg_advisory_lock 不分 schema：并发互斥用例「两次并发启动恰好一个成功」
// 会看见别的文件持有的锁；prisma migrate deploy 自己也拿 advisory lock）、pg_stat_activity、
// 连接数（每个 worker 一个应用 Pool + 一个本文件的 Pool，CI 的 max_connections 很快见底）。
// 串行后同一时刻只有一个临时 schema 在用，这些用例才是确定的，失败时也一眼看得出是哪个文件留下的。
//
// 必须在应用模块加载之前改 process.env（本文件是 setupFiles，先于测试文件的 import 执行）：
// src/core/config.ts 在 import 时读一次 DATABASE_URL 并冻结。这是本文件被 eslint 豁免
// no-restricted-syntax（process.env）的原因，其他测试文件仍然不许碰 env。
//
// 环境变量：TEST_DATABASE_URL 优先，其次 DATABASE_URL；两个都没有直接抛错（不静默跳过，
// 「没库就绿」是最危险的假绿）。连接串要带用户名（`postgresql://user@host/db`）：pg 会回退到
// 系统用户名，Prisma CLI 不会，缺了报 P1010。

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { MockAgent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll } from "vitest";

// ---- 1. 禁外网 ----
const agent = new MockAgent();

agent.disableNetConnect();
// 本机的假服务放行（host 或 host:port 都会来匹配）。
agent.enableNetConnect(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/);
setGlobalDispatcher(agent);

// ---- 2. 临时 schema ----
const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!BASE_URL) {
  throw new Error(
    "测试需要真实 PostgreSQL：设置 TEST_DATABASE_URL（或 DATABASE_URL），例如 postgresql://ci:ci@localhost:5432/ci",
  );
}

/** 本文件的临时 schema 名；需要直接拼 SQL 的测试可以 import 它。 */
export const TEST_SCHEMA = `test_${process.pid}_${randomBytes(4).toString("hex")}`;
/** Prisma CLI（与 src/db/client.ts 的 runMigrations 同一个二进制），不走 npx 免得多一次解析。 */
const PRISMA_BIN = fileURLToPath(
  new URL("../node_modules/.bin/prisma", import.meta.url),
);

const url = new URL(BASE_URL);

url.searchParams.set("schema", TEST_SCHEMA);
process.env.DATABASE_URL = url.toString();
process.env.TEST_DATABASE_URL = url.toString();

// 本文件自己的连接：建 / 删 schema、TRUNCATE。与应用的 Pool 分开，
// afterAll 里先关应用（各测试文件自己 app.close() / closeDb()）再删 schema 也不会互相卡。
// 连的是 BASE_URL（不带 ?schema=），操作全部显式带 schema 名。
const pool = new Pool({ connectionString: BASE_URL, max: 2 });
const quoted = `"${TEST_SCHEMA}"`;

beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${quoted}`);

  // 与 src/db/client.ts 的 runMigrations 同一条命令、同一份 prisma.config.ts：migrate deploy 读
  // DATABASE_URL（已带 ?schema=），表、枚举、_prisma_migrations 都建在临时 schema 里。
  // 不用 prisma migrate reset（会清整个库）、不用 db push（绕过迁移链 —— 测的就是这条链）。
  // stderr 直通：迁移失败时 SQL 错误原样可见。
  execFileSync(PRISMA_BIN, ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: ["ignore", "pipe", "inherit"],
  });
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  await pool.end();
});

/**
 * 清空临时 schema 里的全部表（_prisma_migrations 除外，否则下一个用例的 assertSchemaCurrent
 * 会以为迁移没跑），序列归零。表清单从 pg_tables 拿，不依赖生成的 client。
 * 用法：各测试文件 `beforeEach(truncateAll)`。比逐表 DELETE 快，且 CASCADE 不用管外键顺序。
 */
export async function truncateAll(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations'",
    [TEST_SCHEMA],
  );

  if (rows.length === 0) return;

  const tables = rows.map((r) => `${quoted}."${r.tablename}"`).join(", ");

  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
