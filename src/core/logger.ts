// 进程级 logger：全项目只从这里拿 pino 实例（no-console 在别处拦）。
// 为什么用 pino：结构化 JSON，requestId 之类字段可以直接作为查询键。
// 不在这里读 process.env（只有 src/core/config.ts 可以读）。
import pino from "pino";

export const logger = pino({ level: "info" });

export type Logger = typeof logger;
