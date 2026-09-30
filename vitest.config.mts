import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 每个测试文件加载前先跑：禁外网（undici MockAgent）、建临时 schema、prisma migrate deploy；
    // 导出的 truncateAll() 给各文件的 beforeEach 用。
    setupFiles: ["tests/setup.ts"],
    // 文件串行：测试跑在真实 PostgreSQL 上，setup 给每个文件建一个临时 schema 并把
    // DATABASE_URL 指过去；并行时多个 worker 会同时对同一个库建 schema、跑迁移链、抢
    // advisory lock，用例数据也会互相看见。串行后同一时刻只有一个临时 schema 在用。
    // 文件内的用例照常顺序执行（vitest 默认）。
    fileParallelism: false,
    // beforeAll 里要建 schema + 前滚整条迁移链，冷启动可能超过默认的 10s。
    hookTimeout: 30_000,
    // 覆盖率地板（CI 跑 npm run test:coverage；本地 pre-commit 不跑 vitest，它要真库）。
    // 范围 = 全部 src，只排除入口（listen / 信号处理，测不到也不该测）与 prisma generate 的产物
    // （几万行生成代码会把百分比冲成噪音）。
    // 覆盖率地板只防倒退、只准上调：「lines 实测值减 1 取整」（2026-09-30 实测 lines 89.3%）。
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/main.ts", "src/db/generated/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 88 },
    },
  },
});
