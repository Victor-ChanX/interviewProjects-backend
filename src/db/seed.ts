// 种子：题目 2.1 要求账号在 migration / seed 里预置（初始 idle、platformUserId = null），
// 2.3 要求预置 admin/admin、viewer/viewer。
// 不写进迁移（迁移里不许有数据语句）、不挂 prisma.config.ts 的 migrations.seed。
// 幂等靠 upsert 且 update 为空：已存在的行一个字段都不动 —— 账号的 status / platformUserId
// 是运行态，种子重跑不能把在线账号打回 idle。多副本同时启动靠 upsert 的 ON CONFLICT 扛，不加锁。
// 本地手动跑：npm run db:seed（prisma/seed.ts 只是壳）。
import { hashPassword } from "../core/password.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "./client.js";

/** 预置的服务账号 id（也是网关侧的 accountId）。 */
export const SEED_ACCOUNT_IDS = [
  "acc-1",
  "acc-2",
  "acc-3",
  "acc-4",
  "acc-5",
] as const;

/** 预置用户；口令只在这里出现一次，落库的是 scrypt 哈希。 */
export const SEED_USERS = [
  { username: "admin", password: "admin", role: "admin" },
  { username: "viewer", password: "viewer", role: "viewer" },
] as const;

export type SeedResult = { accountsCreated: number; usersCreated: number };

export async function seedDatabase(db: Db, log: Logger): Promise<SeedResult> {
  // createMany + skipDuplicates 就是 INSERT … ON CONFLICT DO NOTHING，返回真正插入的行数。
  const accounts = await db.account.createMany({
    data: SEED_ACCOUNT_IDS.map((id) => ({ id })),
    skipDuplicates: true,
  });

  let usersCreated = 0;
  for (const user of SEED_USERS) {
    // 先查再算哈希：scrypt 一次几十毫秒，已存在的用户不必每次启动都算；
    // 查到不存在之后的并发插入由 upsert 兜底（单唯一键 + 无嵌套写 → Prisma 用 ON CONFLICT）。
    const existing = await db.user.findUnique({
      where: { username: user.username },
      select: { id: true },
    });
    if (existing) continue;
    const passwordHash = await hashPassword(user.password);
    await db.user.upsert({
      where: { username: user.username },
      create: { username: user.username, passwordHash, role: user.role },
      update: {},
    });
    usersCreated += 1;
  }

  log.info(
    { accountsCreated: accounts.count, usersCreated },
    "种子已灌入（幂等，已存在的行不动）",
  );
  return { accountsCreated: accounts.count, usersCreated };
}
