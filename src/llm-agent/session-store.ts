// 按 runId 的会话状态：记住每次上游返回的**完整** assistant 回合（含思考块 / thoughtSignature），
// 下一轮后端把同一个 tool_use 传回来时，发给上游前换回这份完整内容。
//
// 为什么需要（题目 2.2 允许「Agent 服务按 runId 维护会话状态」）：2.2 的每轮响应恰好一个块，思考内容没有位置，
// 后端传回来的历史里只剩 tool_use；而两家上游都要求多轮工具调用把思考状态原样带回：
// - Claude：思考块要原样回传；中途删掉某个思考块会让它之后的思考块全部失效（新账号直接 400），
//   从最前面删一段则允许（官方模型迁移指南 → preserved thinking）。
// - Gemini 3：functionCall part 上的 thoughtSignature 缺了直接 400（Google 文档 Thought signatures）。
// 两家「记不到」时各自怎么办见 anthropic.ts / gemini.ts。
//
// 取舍：落盘而不是只放内存 —— llm-agent 重启（或后端在 run 中途重启后恢复）时同一个 run 还能接着回传；
// 一个 run 一个文件（配置文件同目录下的 .llm-agent-sessions/，文件名是 runId 的 sha256，目录 700、文件 600），
// 每轮只重写本 run 的小文件。上限：每个 run 最多记 MAX_TURNS_PER_RUN 轮（超出丢最早的 —— 对 Claude 正是允许的
// 「从最前面删」）；目录里最多 MAX_RUNS 个文件、超过 SESSION_TTL_MS 没动过的删掉（run 因步数 / 60 秒 / blocked /
// cancelled 结束时本服务收不到通知，靠这两条回收）。run 以 finish 或 end_turn 结束时 app.ts 直接 forget。
// 并发：同一个 run 同一时刻只有一轮在跑（后端单 runner）；万一重叠，后写的覆盖先写的，丢一轮记忆 = 那一轮按
// 「记不到」处理，不会出错。读写失败只告警、不让本轮失败。
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { systemClock, type Clock } from "../core/clock.js";
import { PROVIDERS, type Provider } from "./config-store.js";

/** 一次上游 assistant 回合的原样内容（Claude：content 块数组；Gemini：model 的 Content） */
export type StoredTurn = {
  provider: Provider;
  model: string;
  content: unknown;
};

export type SessionStore = {
  load(runId: string): Promise<ReadonlyMap<string, StoredTurn>>;
  remember(runId: string, toolUseId: string, turn: StoredTurn): Promise<void>;
  forget(runId: string): Promise<void>;
};

export const MAX_TURNS_PER_RUN = 24;
export const MAX_RUNS = 200;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const RunFile = z.object({
  runId: z.string(),
  turns: z.array(
    z.object({
      toolUseId: z.string(),
      provider: z.enum(PROVIDERS),
      model: z.string(),
      content: z.unknown(),
    }),
  ),
});
type RunFile = z.infer<typeof RunFile>;

/** 配置文件同目录下的会话状态目录 */
export function sessionDirFor(configFilePath: string): string {
  return join(dirname(configFilePath), ".llm-agent-sessions");
}

const isMissing = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "ENOENT";

export function createSessionStore(opts: {
  dir: string;
  clock?: Clock;
}): SessionStore {
  const clock = opts.clock ?? systemClock;
  const fileOf = (runId: string): string =>
    join(opts.dir, `${createHash("sha256").update(runId).digest("hex")}.json`);

  const read = async (runId: string): Promise<RunFile | null> => {
    let raw: string;
    try {
      raw = await readFile(fileOf(runId), "utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const parsed = RunFile.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.runId === runId ? parsed.data : null;
  };

  /** 删掉过期的，再把最旧的删到不超过 MAX_RUNS 个 */
  const prune = async (): Promise<void> => {
    const names = (await readdir(opts.dir)).filter((n) => n.endsWith(".json"));
    const now = clock.now().getTime();
    const files = await Promise.all(
      names.map(async (name) => {
        const path = join(opts.dir, name);
        const info = await stat(path).catch(() => null);
        return { path, mtimeMs: info?.mtimeMs ?? 0 };
      }),
    );
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const doomed = files.filter(
      (f, index) => index >= MAX_RUNS || now - f.mtimeMs > SESSION_TTL_MS,
    );
    await Promise.all(doomed.map((f) => rm(f.path, { force: true })));
  };

  return {
    async load(runId) {
      const file = await read(runId);
      const map = new Map<string, StoredTurn>();
      for (const t of file?.turns ?? []) {
        map.set(t.toolUseId, {
          provider: t.provider,
          model: t.model,
          content: t.content,
        });
      }
      return map;
    },

    async remember(runId, toolUseId, turn) {
      await mkdir(opts.dir, { recursive: true, mode: 0o700 });
      const current = (await read(runId)) ?? { runId, turns: [] };
      const turns = [
        ...current.turns.filter((t) => t.toolUseId !== toolUseId),
        { toolUseId, ...turn },
      ].slice(-MAX_TURNS_PER_RUN);
      const path = fileOf(runId);
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify({ runId, turns }), { mode: 0o600 });
      await rename(tmp, path);
      await prune();
    },

    async forget(runId) {
      await rm(fileOf(runId), { force: true });
    },
  };
}
