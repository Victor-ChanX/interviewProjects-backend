// 手动灌种子：npm run db:seed（tsx prisma/seed.ts）。真正的种子逻辑在 src/db/seed.ts，
// 应用启动时 src/main.ts 也会在迁移之后自动跑同一份 —— 这里只是给本地 / 容器里手动触发用的壳。
// 需要 DATABASE_URL（src/core/config.ts 读）。
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import { seedDatabase } from "../src/db/seed.js";

try {
  await seedDatabase(getDb(), logger);
} finally {
  await closeDb();
}
