// 健康检查的 schemaVersion：prisma/migrations 下按名字排序的最后一个目录名（时间戳前缀，字典序即时间序）。
// 为什么读目录而不是 _prisma_migrations 表：启动时 assertSchemaCurrent()（src/db/client.ts）已经保证
// 目录里的每一条都在库里 finished_at 非空，所以「代码带的最新迁移」= 「库里已应用的最新迁移」；
// 读目录不占连接、库抖动时探活也不跟着 500（探活只回答「进程活着、跑的是哪一版 schema」）。
// 镜像里带 prisma/ 目录（.dockerignore 不排除它），路径相对本文件解析，dist/ 与 src/ 同深度。
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
