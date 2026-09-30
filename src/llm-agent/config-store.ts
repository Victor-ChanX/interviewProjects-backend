// 当前生效的 LLM 配置（base url / api key / 模型）：只来自控制台保存的文件（LLM_AGENT_CONFIG_FILE）。
//
// - 读：每次 /agent/turn、/agent/audit、/admin/* 都调 load() 重新读文件（文件很小），控制台保存后不用重启；
//   多个进程共用同一个文件也一致。文件不存在 → source "none"（/agent/* 回 503）；文件存在但坏了 → 抛错，
//   不当作「未配置」糊过去。
// - 写：先写同目录临时文件（mode 600）再 rename，最后再 chmod 600 —— 不会读到半个文件，key 不会对其他用户可读。
// - key 明文只在这里和发往上游的 Authorization 头里出现：对外只给 hasApiKey + apiKeyHint（前 3 后 4），
//   任何要进响应 / 日志的上游报错先过 redact()。
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { systemClock, type Clock } from "../core/clock.js";

export type LlmConfigSource = "file" | "none";

/** 调上游所需的全部：有它才能服务 /agent/turn、/agent/audit */
export type LlmTarget = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** null = 同 model */
  auditModel: string | null;
};

export type LoadedLlmConfig = {
  source: LlmConfigSource;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  auditModel: string | null;
  /** 文件里的保存时间；none 为 null */
  updatedAt: string | null;
  /** source 为 file 时才有 */
  usable: LlmTarget | null;
};

/** 对外（管理端点）的形状：永不含 key 明文 */
export type LlmConfigView = {
  baseUrl: string | null;
  model: string | null;
  auditModel: string | null;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  updatedAt: string | null;
  source: LlmConfigSource;
};

export type ConfigStore = {
  load(): Promise<LoadedLlmConfig>;
  save(input: LlmTarget): Promise<LoadedLlmConfig>;
};

const StoredFile = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  auditModel: z.string().min(1).nullable(),
  updatedAt: z.string(),
});

/** 去掉首尾空白与末尾的 /：「同一个主机」的比较与拼 url 都用它 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** key 的提示：只露前 3 后 4（`sk-…abcd`）；太短的 key 露了就等于全露，只给省略号 */
export function apiKeyHint(key: string | null): string | null {
  if (!key) return null;
  if (key.length < 12) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 把文本里出现的 key 换成 ***（上游报错可能回显 key） */
export function redact(text: string, key: string | null | undefined): string {
  if (!key || key.length < 4) return text;
  return text.split(key).join("***");
}

export function toView(loaded: LoadedLlmConfig): LlmConfigView {
  return {
    baseUrl: loaded.baseUrl,
    model: loaded.model,
    auditModel: loaded.auditModel,
    hasApiKey: loaded.apiKey !== null,
    apiKeyHint: apiKeyHint(loaded.apiKey),
    updatedAt: loaded.updatedAt,
    source: loaded.source,
  };
}

const NONE: LoadedLlmConfig = Object.freeze({
  source: "none",
  baseUrl: null,
  apiKey: null,
  model: null,
  auditModel: null,
  updatedAt: null,
  usable: null,
});

function fromStored(stored: z.infer<typeof StoredFile>): LoadedLlmConfig {
  const { baseUrl, apiKey, model, auditModel, updatedAt } = stored;
  return {
    source: "file",
    baseUrl,
    apiKey,
    model,
    auditModel,
    updatedAt,
    usable: { baseUrl, apiKey, model, auditModel },
  };
}

const isMissing = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "ENOENT";

export function createConfigStore(opts: {
  filePath: string;
  clock?: Clock;
}): ConfigStore {
  const clock = opts.clock ?? systemClock;

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(opts.filePath, "utf8");
      } catch (err) {
        if (isMissing(err)) return NONE;
        throw err;
      }
      let parsed: z.infer<typeof StoredFile>;
      try {
        parsed = StoredFile.parse(JSON.parse(raw));
      } catch {
        throw new Error(
          `LLM 配置文件 ${opts.filePath} 已损坏：删掉它后在控制台的模型设置里重新保存`,
        );
      }
      return fromStored(parsed);
    },

    async save(input) {
      const stored: z.infer<typeof StoredFile> = {
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apiKey: input.apiKey,
        model: input.model,
        auditModel: input.auditModel,
        updatedAt: clock.now().toISOString(),
      };
      await mkdir(dirname(opts.filePath), { recursive: true });
      const tmp = `${opts.filePath}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, opts.filePath);
      await chmod(opts.filePath, 0o600);
      return fromStored(stored);
    },
  };
}
