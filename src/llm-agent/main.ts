// 真实 LLM 版 Agent 服务入口（题目 C2）：独立进程（`npm run llm-agent`），端口 LLM_AGENT_PORT（默认 8300）。
// 不连数据库、不启 worker；后端把 AGENT_URL 指到这里（http://localhost:8300）即可从模拟器切过来。
// 上游（base url / key / 模型）在控制台的模型设置里配，存进 LLM_AGENT_CONFIG_FILE；没配也能启动（/agent/* 回 503）。
// 缺 LLM_AGENT_ADMIN_TOKEN 时打印怎么配然后退出 1。设计说明见同目录 README.md。
import { resolve } from "node:path";

import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import {
  AUDIT_TIMEOUT_MS,
  MODELS_TIMEOUT_MS,
  buildLlmAgentApp,
} from "./app.js";
import { createConfigStore } from "./config-store.js";
import { createOpenAiClient } from "./openai-client.js";

/** 429 / 5xx / 连接失败时最多再试几次（仍受总预算约束） */
const MAX_RETRIES = 2;

async function main(): Promise<void> {
  const adminToken = config.llmAgentAdminToken;
  if (!adminToken) {
    logger.fatal(
      "缺少 LLM_AGENT_ADMIN_TOKEN：在 .env 里设一个随机长串（openssl rand -hex 32），后端与 llm-agent 用同一个值",
    );
    process.exit(1);
  }
  // 预算关系：本服务的上游预算必须短于后端的每轮超时，否则后端先放弃、本服务的答案白算。
  // 两个进程通常共用同一份 .env，这里能读到后端的值。
  if (config.llmTimeoutMs >= config.agentTurnTimeoutMs) {
    logger.warn(
      `LLM_TIMEOUT_MS（${config.llmTimeoutMs}）不小于后端的 AGENT_TURN_TIMEOUT_MS（${config.agentTurnTimeoutMs}）：慢响应会被后端判 TURN_TIMEOUT 丢弃，建议比它小 1–2 秒`,
    );
  }
  if (AUDIT_TIMEOUT_MS >= config.agentAuditTimeoutMs) {
    logger.warn(
      `审计的上游预算（${AUDIT_TIMEOUT_MS}ms）不小于后端的 AGENT_AUDIT_TIMEOUT_MS（${config.agentAuditTimeoutMs}）：审计会被后端当作超时重试`,
    );
  }

  const configFile = resolve(config.llmAgentConfigFile);
  const store = createConfigStore({ filePath: configFile });
  const loaded = await store.load();
  if (!loaded.usable) {
    logger.warn(
      { configFile },
      "尚未配置 LLM：/agent/turn、/agent/audit 会回 503，直到在控制台的模型设置里保存一次",
    );
  }

  const app = await buildLlmAgentApp({
    upstream: createOpenAiClient({ maxRetries: MAX_RETRIES }),
    store,
    adminToken,
    settings: {
      turnTimeoutMs: config.llmTimeoutMs,
      auditTimeoutMs: AUDIT_TIMEOUT_MS,
      modelsTimeoutMs: MODELS_TIMEOUT_MS,
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "llm-agent 收到停机信号");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.llmAgentPort, host: "0.0.0.0" });
  logger.info(
    {
      configFile,
      baseUrl: loaded.baseUrl,
      model: loaded.model,
      source: loaded.source,
    },
    "llm-agent 已启动",
  );
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "llm-agent 启动失败");
  process.exit(1);
});
