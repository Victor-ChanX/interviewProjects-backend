// Prisma 7 CLI 的配置（仓根 prisma.config.ts）：npm run db:migrate（migrate dev --create-only）、
// db:deploy 与启动时的 migrate deploy、scripts/check-migration-drift.mjs（migrate diff）、
// prisma generate 都读它。datasource 的 url 已经不写在 schema.prisma 里，只在这里。
//
// 这是 src/core/config.ts 之外唯一允许读 process.env 的文件：prisma CLI 自己加载它，不经过应用，
// 所以 eslint.config.mjs 把它列进 ignores。
//
// 为什么不用 prisma/config 的 env("DATABASE_URL")：它在变量缺失时直接 throw，而 prisma generate
// （npm install 的 postinstall、生成地图之前）不需要数据库；migrate 类命令才需要 url，缺失时由
// CLI 自己报「datasource.url property is required」。所以直接读 process.env，允许 undefined。
//
// shadowDatabaseUrl：migrate diff --from-migrations 必须有一个 shadow 库（7.x 没有
// --shadow-database-url 参数，只认这里）。**shadow 库会被清空再前滚迁移**，永远不要指到有数据的库；
// scripts/check-migration-drift.mjs 自己建一次性库、经 SHADOW_DATABASE_URL 传进来、用完删，
// 平时不用设。migrate dev 不需要它（引擎自己建临时库）。
import { defineConfig } from "prisma/config";

export default defineConfig({
  // 数据模型；project-map 生成器也读它（DMMF）。
  schema: "prisma/schema.prisma",
  migrations: {
    // 生成的 <时间戳>_<名字>/migration.sql：人工审过后与 schema 改动同一个 commit 提交。
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
