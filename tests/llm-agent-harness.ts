// llm-agent 测试的共用搭建：临时目录里的配置文件 + 会话状态目录，上游指向假 Anthropic / 假 Gemini。
// tests/llm-agent.test.ts 与 tests/llm-settings.test.ts 共用。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { createAnthropicClient } from "../src/llm-agent/anthropic.js";
import {
  AUDIT_TIMEOUT_MS,
  buildLlmAgentApp,
  type LlmAgentAppOptions,
} from "../src/llm-agent/app.js";
import {
  createConfigStore,
  type ConfigStore,
} from "../src/llm-agent/config-store.js";
import { createGeminiClient } from "../src/llm-agent/gemini.js";
import {
  createSessionStore,
  sessionDirFor,
  type SessionStore,
} from "../src/llm-agent/session-store.js";

export const ADMIN_TOKEN = "test-admin-token-0123456789";

/** 一个临时目录：配置文件与会话状态都在里面（测试结束 cleanup() 删掉） */
export async function tempLlmAgentDir(): Promise<{
  filePath: string;
  store: ConfigStore;
  sessions: SessionStore;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "llm-agent-test-"));
  const filePath = join(dir, "llm-agent.json");
  return {
    filePath,
    store: createConfigStore({ filePath }),
    sessions: createSessionStore({ dir: sessionDirFor(filePath) }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 用假上游建一个 llm-agent（SDK 重试的等待由假服务的 retry-after-ms / 1ms 首次退避压到几乎为 0） */
export async function buildTestLlmAgent(
  opts: {
    store: ConfigStore;
    sessions: SessionStore;
    anthropicUrl: string;
    geminiUrl: string;
    turnTimeoutMs?: number;
    maxRetries?: number;
  } & Pick<LlmAgentAppOptions, "logger">,
): Promise<FastifyInstance> {
  const maxRetries = opts.maxRetries ?? 2;
  return buildLlmAgentApp({
    logger: opts.logger ?? false,
    store: opts.store,
    sessions: opts.sessions,
    adminToken: ADMIN_TOKEN,
    clients: {
      anthropic: createAnthropicClient({
        testBaseURL: opts.anthropicUrl,
        maxRetries,
      }),
      gemini: createGeminiClient({
        testBaseUrl: opts.geminiUrl,
        maxRetries,
        retryInitialDelayMs: 1,
      }),
    },
    settings: {
      turnTimeoutMs: opts.turnTimeoutMs ?? 3_000,
      auditTimeoutMs: AUDIT_TIMEOUT_MS,
      modelsTimeoutMs: 3_000,
    },
  });
}
