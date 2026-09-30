// 媒体文件（题目 C1，issue #38）：message 事件带 mediaUrl 时把文件下载到本地 MEDIA_DIR（默认 media/），路径记在
// messages.localFilePath；定期删除超过保留期（MEDIA_RETENTION_DAYS，默认 30 天）的文件。
//
// 下载不在入站事件的事务里做（不能让一次慢下载拖住事件流）：入站写消息时排上 mediaNextAttemptAt = 收到时刻，
// media-worker 按它领取（FOR UPDATE SKIP LOCKED + 租约，多副本各领各的）→ 下载 → 写盘 → 记 localFilePath。
// - 只下载网关自己的地址（gateway-client.downloadMedia 校验同源）；不是 → 放弃，mediaError = MEDIA_URL_UNTRUSTED。
// - 网关 404（过期，题目 2.1）→ 放弃，MEDIA_EXPIRED；连不上 / 5xx → 有界退避，耗尽 → MEDIA_UNAVAILABLE。
// - 写盘先写临时文件再 rename，读者看不到半个文件；写完盘、记账前崩溃 → 留下一个没有记录指向的文件，由清理步骤
//   当孤儿删掉；租约到期后这条被重新领取下载。
//
// 清理（purgeExpiredMedia）：「删除后不能留下指向已删文件的记录」—— 所以顺序是**先在库里清 localFilePath**
// （同一事务记 mediaPurgedAt），commit 之后再删盘上的文件；崩在两者之间只会留下没有记录指向的孤儿文件，下一次清理
// 扫目录时删掉（孤儿要比 ORPHAN_GRACE_MS 旧，免得删掉「刚写完、还没记账」的文件）。
// 文件被外部删掉（存储卷丢了 / 换了机器）时同样不能留下指向它的记录：清理时对账，记录指向的文件不在了 → 清掉
// localFilePath 并重新排下载（网关那边还没过期就能补回来，过期了记 MEDIA_EXPIRED）。
// 「仍被运行中的 agent run 用到的文件不删」：agent 读的是所在群的消息（触发消息、待处理消息、get_recent_messages），
// 所以所在群有 running 的 agent run 的消息一律跳过，run 结束后的下一次清理再删。
//
// 盘上的读写集中在 MediaStore（本地目录实现）；换对象存储时只换它，业务流程不动。
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";

import { type Clock, systemClock } from "../core/clock.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import {
  type GatewayClient,
  GatewayResponseError,
  UntrustedMediaUrlError,
} from "./gateway-client.js";

// ---- 常量 ------------------------------------------------------------------------------

/** 下载重试：base × 2^(attempts-1)，封顶 cap；失败这么多次后放弃 */
export const MEDIA_RETRY_BASE_MS = 2_000;
export const MEDIA_RETRY_CAP_MS = 5 * 60_000;
export const MEDIA_MAX_ATTEMPTS = 5;
/** 领取时把 mediaNextAttemptAt 往后推这么久：下载中的不会被别的副本同时领走；进程死了到点再被领 */
export const MEDIA_LEASE_MS = 60_000;
/** 一次最多领多少条 */
export const MEDIA_BATCH = 20;
/** 目录里没有记录指向的文件，比这个旧才当孤儿删（避开「刚写完盘、还没记账」的文件） */
export const ORPHAN_GRACE_MS = 60 * 60_000;
/** 一次清理最多处理多少条过期记录 */
export const PURGE_BATCH = 500;

export const MEDIA_ERRORS = Object.freeze({
  expired: "MEDIA_EXPIRED",
  unavailable: "MEDIA_UNAVAILABLE",
  untrusted: "MEDIA_URL_UNTRUSTED",
  writeFailed: "MEDIA_WRITE_FAILED",
});

// ---- 存储 ------------------------------------------------------------------------------

/** 媒体文件的存放处。path 是记进 messages.localFilePath 的值 */
export type MediaStore = {
  /** 写一个文件，返回它的 path；同名覆盖 */
  write(name: string, bytes: Buffer): Promise<string>;
  /** 删掉 path；已经不在视为成功 */
  remove(path: string): Promise<void>;
  /** 列出全部文件（path + 最后修改时刻），清理孤儿用 */
  list(): Promise<{ path: string; modifiedAt: Date }[]>;
};

/** 本地目录实现：path = `<dir>/<name>`（与 MEDIA_DIR 同样相对启动目录） */
export function localMediaStore(dir: string): MediaStore {
  const pathOf = (name: string): string => join(dir, name);
  return {
    async write(name, bytes) {
      await mkdir(dir, { recursive: true });
      const target = pathOf(name);
      // 先写临时文件再 rename：同一文件系统内 rename 是原子的，读者看不到半个文件
      const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, bytes);
      await rename(tmp, target);
      return target;
    },
    async remove(path) {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: { path: string; modifiedAt: Date }[] = [];
      for (const name of names) {
        const path = pathOf(name);
        try {
          const info = await stat(path);
          if (info.isFile()) out.push({ path, modifiedAt: info.mtime });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      return out;
    },
  };
}

// ---- 下载 ------------------------------------------------------------------------------

export type MediaDeps = {
  clock?: Clock;
  log?: Pick<Logger, "info" | "warn" | "error">;
  store: MediaStore;
};

export type DownloadResult = {
  claimed: number;
  downloaded: number;
  /** 放弃（过期 / 不可信 / 重试耗尽） */
  abandoned: number;
  /** 退避后再试 */
  retrying: number;
};

/** 常见类型给个扩展名，方便人看；认不出的不带 */
const EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
});

function fileNameFor(
  messageId: string,
  mediaUrl: string,
  contentType: string | null,
): string {
  const byType = contentType
    ? EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()]
    : undefined;
  let byUrl: string;
  try {
    byUrl = extname(new URL(mediaUrl, "http://x/").pathname).toLowerCase();
  } catch {
    byUrl = "";
  }
  const ext = byType ?? (/^\.[a-z0-9]{1,8}$/.test(byUrl) ? byUrl : "");
  return `${messageId}${ext}`;
}

function retryDelay(attempts: number): number {
  return Math.min(
    MEDIA_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    MEDIA_RETRY_CAP_MS,
  );
}

/** 到期要下载的消息：领取（续租约）→ 逐条下载、写盘、记账。 */
export async function downloadDueMedia(
  deps: MediaDeps & {
    gateway: Pick<GatewayClient, "downloadMedia">;
    limit?: number;
  },
): Promise<DownloadResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const leaseUntil = new Date(now.getTime() + MEDIA_LEASE_MS);
  const rows = await getDb().$queryRaw<
    { id: string; media_url: string; media_attempts: number }[]
  >`
    UPDATE messages
    SET media_next_attempt_at = ${leaseUntil}, media_attempts = media_attempts + 1
    WHERE id IN (
      SELECT id FROM messages
      WHERE media_next_attempt_at <= ${now}
        AND media_url IS NOT NULL
        AND local_file_path IS NULL
      ORDER BY media_next_attempt_at, id
      LIMIT ${deps.limit ?? MEDIA_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, media_url, media_attempts`;

  const result: DownloadResult = {
    claimed: rows.length,
    downloaded: 0,
    abandoned: 0,
    retrying: 0,
  };
  for (const row of rows) {
    const outcome = await downloadOne(row, deps, clock);
    result[outcome] += 1;
  }
  return result;
}

async function downloadOne(
  row: { id: string; media_url: string; media_attempts: number },
  deps: MediaDeps & { gateway: Pick<GatewayClient, "downloadMedia"> },
  clock: Clock,
): Promise<"downloaded" | "abandoned" | "retrying"> {
  const ctx = { messageId: row.id, mediaUrl: row.media_url };
  let file: { bytes: Buffer; contentType: string | null };
  try {
    file = await deps.gateway.downloadMedia(row.media_url);
  } catch (err) {
    if (err instanceof UntrustedMediaUrlError) {
      await abandon(row.id, MEDIA_ERRORS.untrusted);
      deps.log?.warn({ ...ctx }, "mediaUrl 不是网关的地址，不下载");
      return "abandoned";
    }
    if (err instanceof GatewayResponseError && err.status === 404) {
      await abandon(row.id, MEDIA_ERRORS.expired);
      deps.log?.info(ctx, "媒体文件已过期（网关 404），放弃下载");
      return "abandoned";
    }
    if (row.media_attempts >= MEDIA_MAX_ATTEMPTS) {
      await abandon(row.id, MEDIA_ERRORS.unavailable, err);
      deps.log?.warn({ ...ctx, err }, "媒体文件下载重试耗尽，放弃");
      return "abandoned";
    }
    const next = new Date(
      clock.now().getTime() + retryDelay(row.media_attempts),
    );
    await getDb().message.updateMany({
      where: { id: row.id, localFilePath: null },
      data: { mediaNextAttemptAt: next, mediaError: describe(err) },
    });
    deps.log?.warn({ ...ctx, err, next }, "媒体文件下载失败，稍后再试");
    return "retrying";
  }

  let path: string;
  try {
    path = await deps.store.write(
      fileNameFor(row.id, row.media_url, file.contentType),
      file.bytes,
    );
  } catch (err) {
    // 写盘失败（盘满 / 权限）：和下载失败一样按次数退避、有上限，不中断这一批里的其他文件
    if (row.media_attempts >= MEDIA_MAX_ATTEMPTS) {
      await abandon(row.id, MEDIA_ERRORS.writeFailed, err);
      deps.log?.error({ ...ctx, err }, "媒体文件写盘重试耗尽，放弃");
      return "abandoned";
    }
    const next = new Date(
      clock.now().getTime() + retryDelay(row.media_attempts),
    );
    await getDb().message.updateMany({
      where: { id: row.id, localFilePath: null },
      data: { mediaNextAttemptAt: next, mediaError: describe(err) },
    });
    deps.log?.error({ ...ctx, err, next }, "媒体文件写盘失败，稍后再试");
    return "retrying";
  }
  const recorded = await getDb().message.updateMany({
    where: { id: row.id, localFilePath: null },
    data: {
      localFilePath: path,
      mediaFetchedAt: clock.now(),
      mediaNextAttemptAt: null,
      mediaError: null,
    },
  });
  if (recorded.count === 0) {
    // 别的副本抢先记好了（租约过期后被重新领取）：这份是多余的，删掉
    await deps.store.remove(path);
    return "abandoned";
  }
  deps.log?.info({ ...ctx, path, bytes: file.bytes.length }, "媒体文件已下载");
  return "downloaded";
}

async function abandon(
  messageId: string,
  code: string,
  err?: unknown,
): Promise<void> {
  await getDb().message.updateMany({
    where: { id: messageId, localFilePath: null },
    data: {
      mediaNextAttemptAt: null,
      mediaError: err === undefined ? code : `${code}: ${describe(err)}`,
    },
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- 清理 ------------------------------------------------------------------------------

export type PurgeResult = {
  /** 过保留期、已清掉记录并删掉文件的条数 */
  purged: number;
  /** 所在群有 running 的 agent run、这次跳过的条数 */
  keptForAgent: number;
  /** 删掉的孤儿文件数 */
  orphansRemoved: number;
  /** 记录指向的文件已经不在（被外部删掉），清掉路径、重新排下载的条数 */
  missingRescheduled: number;
};

/**
 * 删除超过保留期的媒体文件（见文件头的顺序）：先清记录、commit 后删文件；再扫目录删孤儿。幂等。
 */
export async function purgeExpiredMedia(
  deps: MediaDeps & { retentionDays: number },
): Promise<PurgeResult> {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const cutoff = new Date(now.getTime() - deps.retentionDays * 86_400_000);
  const db = getDb();

  const expired = await db.$queryRaw<{ id: string; local_file_path: string }[]>`
    SELECT m.id, m.local_file_path
    FROM messages m
    WHERE m.local_file_path IS NOT NULL AND m.media_fetched_at < ${cutoff}
    ORDER BY m.media_fetched_at, m.id
    LIMIT ${PURGE_BATCH}`;

  // 1. 先清记录，commit 之后再删文件。「在用」只在清记录的这一条语句里判：仍指向这个文件、且所在群此刻没有运行中的
  //    agent run —— 判断与删除原子，上面的查询之后才启动的 run，它用到的文件同样不删
  const cleared = await db.$transaction(async (tx) => {
    const done: string[] = [];
    for (const r of expired) {
      const count = await tx.$executeRaw`
        UPDATE messages m
        SET local_file_path = NULL, media_purged_at = ${now}
        WHERE m.id = ${r.id}
          AND m.local_file_path = ${r.local_file_path}
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs ar
            WHERE ar.group_id = m.group_id AND ar.status = 'running'
          )`;
      if (count === 1) done.push(r.local_file_path);
    }
    return done;
  });
  const keptForAgent = expired.length - cleared.length;
  for (const path of cleared) await deps.store.remove(path);

  // 2. 孤儿：目录里没有任何记录指向、且足够旧的文件（崩在「清记录」与「删文件」之间，或「写盘」与「记账」之间留下的）
  const files = await deps.store.list();

  // 3. 反向对账：记录指向、盘上却没有的文件（存储卷丢了 / 被人删了）→ 清路径、重新排下载。
  //    只看下载完成超过宽限期的，避开「刚记完账」的读写竞态。
  const present = files.map((f) => f.path);
  const settledBefore = new Date(now.getTime() - ORPHAN_GRACE_MS);
  const missing = await db.$queryRaw<{ id: string }[]>`
    UPDATE messages
    SET local_file_path = NULL, media_fetched_at = NULL,
        media_next_attempt_at = ${now}, media_attempts = 0,
        media_error = 'MEDIA_FILE_MISSING'
    WHERE local_file_path IS NOT NULL
      AND media_fetched_at < ${settledBefore}
      AND NOT (local_file_path = ANY(${present}::text[]))
    RETURNING id`;

  const oldEnough = files.filter(
    (f) => now.getTime() - f.modifiedAt.getTime() >= ORPHAN_GRACE_MS,
  );
  let orphansRemoved = 0;
  if (oldEnough.length > 0) {
    const referenced = new Set(
      (
        await db.message.findMany({
          where: { localFilePath: { in: oldEnough.map((f) => f.path) } },
          select: { localFilePath: true },
        })
      ).map((m) => m.localFilePath),
    );
    for (const f of oldEnough) {
      if (referenced.has(f.path)) continue;
      await deps.store.remove(f.path);
      orphansRemoved += 1;
    }
  }

  const missingRescheduled = missing.length;
  if (
    cleared.length > 0 ||
    orphansRemoved > 0 ||
    keptForAgent > 0 ||
    missingRescheduled > 0
  ) {
    deps.log?.info(
      {
        purged: cleared.length,
        keptForAgent,
        orphansRemoved,
        missingRescheduled,
      },
      "媒体文件清理",
    );
  }
  return {
    purged: cleared.length,
    keptForAgent,
    orphansRemoved,
    missingRescheduled,
  };
}
