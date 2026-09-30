// issue #38（题目 C1）：媒体文件下载到本地、记 localFilePath、按保留期清理（先清记录再删文件）、孤儿与丢失文件对账、
// 运行中的 agent run 用到的不删。
// 真库；网关用 src/sim/gateway 起在 listen(0) 上（GET /media/:id 真 HTTP）；媒体目录是每个用例一个的临时目录。
// 时间：假时钟（下载退避、保留期都按它算）；孤儿的「足够旧」按文件 mtime，用 utimes 拨回去。
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Clock } from "../src/core/clock.js";
import { logger } from "../src/core/logger.js";
import { closeDb, getDb } from "../src/db/client.js";
import type { Group } from "../src/db/generated/client.js";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayEvent,
  GatewayUnreachableError,
} from "../src/services/gateway-client.js";
import { ingest } from "../src/services/inbound-service.js";
import {
  downloadDueMedia,
  localMediaStore,
  MEDIA_ERRORS,
  MEDIA_RETRY_BASE_MS,
  type MediaStore,
  ORPHAN_GRACE_MS,
  purgeExpiredMedia,
} from "../src/services/media-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { makeAgentRun, makeGroup, makeMessage } from "./factories.js";
import { truncateAll } from "./setup.js";

const silent = logger.child({}, { level: "silent" });
const DAY_MS = 86_400_000;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function fakeClock(): Clock & { advance(ms: number): void; reset(): void } {
  let now = Date.now();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
    reset() {
      now = Date.now();
    },
  };
}

describe("媒体文件（C1）", () => {
  const clock = fakeClock();
  let gateway: FastifyInstance;
  let client: GatewayClient;
  let dir: string;
  let store: MediaStore;
  let group: Group;
  let fedUpTo = 0;

  beforeAll(async () => {
    gateway = await buildGatewayApp({ logger: false, clock });
    const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
    client = createGatewayClient({ baseUrl: url });
  });

  beforeEach(async () => {
    await truncateAll();
    clock.reset();
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    fedUpTo = 0;
    dir = await mkdtemp(join(tmpdir(), "media-test-"));
    store = localMediaStore(dir);
    await gateway.inject({ method: "POST", url: "/accounts/a1/connect" });
    const created = await gateway.inject({
      method: "POST",
      url: "/groups",
      payload: { creatorAccountId: "a1" },
    });
    group = await makeGroup({
      gatewayGroupId: created.json<{ groupId: string }>().groupId,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await gateway.close();
    await closeDb();
  });

  /** 外部用户发一条带附件的消息，事件喂给入站（真实入口），返回本地消息行 */
  async function pushMedia(media: { expiresAfterMs?: number } = {}) {
    await gateway.inject({
      method: "POST",
      url: "/_sim/push",
      payload: {
        kind: "message",
        groupId: group.gatewayGroupId,
        senderPlatformUserId: "ext-1",
        text: "看图",
        media: {
          contentType: "image/png",
          base64: PNG.toString("base64"),
          ...media,
        },
      },
    });
    const state = (
      await gateway.inject({ method: "GET", url: "/_sim/state" })
    ).json<{ events: { items: GatewayEvent[] } }>();
    for (const e of state.events.items) {
      if (e.eventId <= fedUpTo) continue;
      await ingest(e, { clock, log: silent });
      fedUpTo = e.eventId;
    }
    return getDb().message.findFirstOrThrow({
      where: { groupId: group.id },
      orderBy: { createdAt: "desc" },
    });
  }

  const download = (gw: GatewayClient = client) =>
    downloadDueMedia({ clock, gateway: gw, store, log: silent });
  const purge = (retentionDays = 30) =>
    purgeExpiredMedia({ clock, store, retentionDays, log: silent });
  const row = (id: string) =>
    getDb().message.findUniqueOrThrow({ where: { id } });

  describe("下载", () => {
    it("带 mediaUrl 的消息：入站时排上下载，worker 下到本地目录，localFilePath 记路径，字节一致", async () => {
      const msg = await pushMedia();
      expect(msg.mediaUrl).toMatch(/\/media\//);
      expect(msg.mediaNextAttemptAt).not.toBeNull();
      expect(msg.localFilePath).toBeNull();

      expect(await download()).toMatchObject({ claimed: 1, downloaded: 1 });
      const done = await row(msg.id);
      expect(done.localFilePath).toBe(join(dir, `${msg.id}.png`));
      expect(done.mediaFetchedAt).toEqual(clock.now());
      expect(done.mediaNextAttemptAt).toBeNull();
      expect(await readFile(done.localFilePath!)).toEqual(PNG);
      // 下完不再领
      expect((await download()).claimed).toBe(0);
    });

    it("网关 404（已过期）→ 放弃，记 MEDIA_EXPIRED，不再重试", async () => {
      const msg = await pushMedia({ expiresAfterMs: 0 });
      expect(await download()).toMatchObject({ claimed: 1, abandoned: 1 });
      expect(await row(msg.id)).toMatchObject({
        localFilePath: null,
        mediaNextAttemptAt: null,
        mediaError: MEDIA_ERRORS.expired,
      });
      clock.advance(DAY_MS);
      expect((await download()).claimed).toBe(0);
    });

    it("mediaUrl 不是网关的地址 → 不发请求、放弃（MEDIA_URL_UNTRUSTED）", async () => {
      let called = false;
      const spy: GatewayClient = {
        ...client,
        async downloadMedia(url) {
          called = true;
          return client.downloadMedia(url);
        },
      };
      const msg = await makeMessage({
        groupId: group.id,
        mediaUrl: "http://evil.test/steal.png",
        mediaNextAttemptAt: clock.now(),
      });
      expect(await download(spy)).toMatchObject({ abandoned: 1 });
      expect(called).toBe(true); // 客户端自己拒绝，不会真的去请求
      expect(await row(msg.id)).toMatchObject({
        localFilePath: null,
        mediaError: MEDIA_ERRORS.untrusted,
      });
    });

    it("网关一时不可用 → 退避后再试，成功后照常记录", async () => {
      const msg = await pushMedia();
      let failures = 1;
      const flaky: GatewayClient = {
        ...client,
        async downloadMedia(url) {
          if (failures-- > 0) {
            throw new GatewayUnreachableError("GET", url, new Error("down"));
          }
          return client.downloadMedia(url);
        },
      };
      expect(await download(flaky)).toMatchObject({ retrying: 1 });
      const waiting = await row(msg.id);
      expect(waiting.mediaNextAttemptAt!.getTime()).toBe(
        clock.now().getTime() + MEDIA_RETRY_BASE_MS,
      );
      expect((await download(flaky)).claimed).toBe(0); // 还没到点
      clock.advance(MEDIA_RETRY_BASE_MS);
      expect(await download(flaky)).toMatchObject({ downloaded: 1 });
      expect((await row(msg.id)).localFilePath).not.toBeNull();
    });
  });

  describe("清理", () => {
    /** 一条已下载的消息：文件写进目录，mediaFetchedAt = ageMs 之前 */
    async function downloaded(ageMs: number, groupId = group.id) {
      const msg = await makeMessage({
        groupId,
        mediaUrl: "/media/x",
      });
      const path = await store.write(`${msg.id}.png`, PNG);
      await getDb().message.update({
        where: { id: msg.id },
        data: {
          localFilePath: path,
          mediaFetchedAt: new Date(clock.now().getTime() - ageMs),
        },
      });
      return { id: msg.id, path };
    }

    const exists = async (path: string) =>
      readFile(path).then(
        () => true,
        () => false,
      );

    it("超过保留期：记录先清（localFilePath 置空、记 mediaPurgedAt），文件删掉；没到期的不动", async () => {
      const old = await downloaded(31 * DAY_MS);
      const fresh = await downloaded(29 * DAY_MS);
      expect(await purge(30)).toMatchObject({ purged: 1, keptForAgent: 0 });
      expect(await row(old.id)).toMatchObject({
        localFilePath: null,
        mediaPurgedAt: clock.now(),
      });
      expect(await exists(old.path)).toBe(false);
      expect((await row(fresh.id)).localFilePath).toBe(fresh.path);
      expect(await exists(fresh.path)).toBe(true);
      // 清过的不会被重新下载
      expect((await download()).claimed).toBe(0);
    });

    it("所在群有运行中的 agent run：过期也不删；run 结束后的下一次清理再删", async () => {
      const old = await downloaded(31 * DAY_MS);
      const run = await makeAgentRun({ groupId: group.id, status: "running" });
      expect(await purge(30)).toMatchObject({ purged: 0, keptForAgent: 1 });
      expect(await exists(old.path)).toBe(true);
      expect((await row(old.id)).localFilePath).toBe(old.path);

      await getDb().agentRun.update({
        where: { id: run.id },
        data: {
          status: "finished",
          endReason: "final",
          finishedAt: clock.now(),
        },
      });
      expect(await purge(30)).toMatchObject({ purged: 1 });
      expect(await exists(old.path)).toBe(false);
    });

    it("孤儿文件（没有记录指向，比如崩在「清记录」与「删文件」之间）：足够旧的删掉，刚写的留着", async () => {
      const stale = join(dir, "orphan-old.png");
      const recent = join(dir, "orphan-new.png");
      await writeFile(stale, PNG);
      await writeFile(recent, PNG);
      const past = new Date(clock.now().getTime() - ORPHAN_GRACE_MS - 1_000);
      await utimes(stale, past, past);
      const kept = await downloaded(DAY_MS);
      expect(await purge(30)).toMatchObject({ orphansRemoved: 1 });
      expect(await exists(stale)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(kept.path)).toBe(true);
    });

    it("记录指向的文件被外部删掉（卷丢了）：清掉路径、重新排下载 —— 不留下指向不存在文件的记录", async () => {
      const lost = await downloaded(2 * ORPHAN_GRACE_MS);
      await rm(lost.path);
      expect(await purge(30)).toMatchObject({ missingRescheduled: 1 });
      expect(await row(lost.id)).toMatchObject({
        localFilePath: null,
        mediaFetchedAt: null,
        mediaNextAttemptAt: clock.now(),
        mediaError: "MEDIA_FILE_MISSING",
      });
    });
  });
});
