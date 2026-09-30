// 唯一允许读 process.env 的地方（eslint no-restricted-syntax 在其他文件拦）。
// 为什么集中：环境变量散落各处会让「哪些配置影响行为」无法一眼看全，
// 也让测试无法用注入替代。这里读一次、校验一次、导出冻结对象。

export type Config = {
  /** HTTP 监听端口 */
  port: number;
  /** PostgreSQL 连接串；生成地图 / 导 openapi 时可以没有 */
  databaseUrl: string | undefined;
  /**
   * 生成 project-map / openapi 时由脚本置 "1"：
   * buildApp 不连库、main 不启 worker，保证生成物与环境无关。
   */
  projectMapBuild: boolean;
};

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PORT 不是合法端口：${raw}`);
  }
  return n;
}

export const config: Readonly<Config> = Object.freeze({
  port: readPort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL || undefined,
  projectMapBuild: process.env.PROJECT_MAP_BUILD === "1",
});
