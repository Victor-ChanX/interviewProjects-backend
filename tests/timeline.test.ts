// issue #9：群消息时间线 GET /api/groups/:id/messages（题目 2.3）。
// 真库（tests/setup.ts 的临时 schema），直接往 messages 表插行（tests/factories.ts 的 makeMessage）。
// 时间从「现在」推导，不写死年月；sentAt 用毫秒精度的 Date（游标按 ISO 毫秒编码）。
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import type { Message } from "../src/db/generated/client.js";
import type { MessagePage, MessageRead } from "../src/schemas/message.js";
import { loginAs, makeGroup, makeMessage } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string; message: string } };

describe("GET /api/groups/:id/messages", () => {
  let app: FastifyInstance;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const list = (
    groupId: string,
    query: Record<string, string> = {},
    headers: Record<string, string> = viewer,
  ) =>
    app.inject({
      method: "GET",
      url: `/api/groups/${groupId}/messages`,
      query,
      headers,
    });

  /** 造 n 条消息，sentAt = base − i 秒（i 越大越早）；返回按插入顺序 */
  async function seed(
    groupId: string,
    n: number,
    base = new Date(),
  ): Promise<Message[]> {
    const rows: Message[] = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(
        await makeMessage({
          groupId,
          sentAt: new Date(base.getTime() - i * 1000),
          text: `m${i}`,
        }),
      );
    }
    return rows;
  }

  const idsOf = (items: MessageRead[]) => items.map((m) => m.text);

  it("主流程：按 sentAt 倒序，字段按题目 2.3；自己的消息从 queued 起就在列表里", async () => {
    const group = await makeGroup();
    const now = new Date();
    const older = await makeMessage({
      groupId: group.id,
      sentAt: new Date(now.getTime() - 2000),
      msgId: "gw-1",
      senderPlatformUserId: "pu-other",
      text: "hello",
    });
    const own = await makeMessage({
      groupId: group.id,
      sentAt: new Date(now.getTime() - 1000),
      isOwn: true,
      clientMsgId: "cm-1",
      accountId: group.creatorAccountId,
      senderPlatformUserId: "pu-self",
      deliveryStatus: "queued",
      text: "mine",
    });
    const failed = await makeMessage({
      groupId: group.id,
      sentAt: now,
      isOwn: true,
      clientMsgId: "cm-2",
      accountId: group.creatorAccountId,
      senderPlatformUserId: "pu-self",
      deliveryStatus: "failed",
      failCode: "ACCOUNT_TERMINAL",
      text: "nope",
    });

    const res = await list(group.id);
    expect(res.statusCode).toBe(200);
    const body = res.json<MessagePage>();
    expect(body.nextCursor).toBeNull();
    expect(idsOf(body.items)).toEqual([failed.text, own.text, older.text]);

    expect(body.items[1]).toEqual({
      msgId: null,
      clientMsgId: "cm-1",
      senderPlatformUserId: "pu-self",
      isOwn: true,
      text: "mine",
      sentAt: own.sentAt.toISOString(),
      deliveryStatus: "queued",
      failCode: null,
      mediaUrl: null,
      localFilePath: null,
    });
    expect(body.items[2]).toEqual({
      msgId: "gw-1",
      clientMsgId: null,
      senderPlatformUserId: "pu-other",
      isOwn: false,
      text: "hello",
      sentAt: older.sentAt.toISOString(),
      deliveryStatus: null,
      failCode: null,
      mediaUrl: null,
      localFilePath: null,
    });
    expect(body.items[0]).toMatchObject({
      deliveryStatus: "failed",
      failCode: "ACCOUNT_TERMINAL",
    });
  });

  it("游标翻页不重不漏：翻页途中插入更新的消息、同一 sentAt 的行跨页", async () => {
    const group = await makeGroup();
    const base = new Date();
    const rows = await seed(group.id, 7, base);
    // 两条与 m2 同一 sentAt 的行：排序键退到 id，游标必须带 id 才不重不漏
    const tieAt = rows[2]!.sentAt;
    const ties = [
      await makeMessage({ groupId: group.id, sentAt: tieAt, text: "tie-a" }),
      await makeMessage({ groupId: group.id, sentAt: tieAt, text: "tie-b" }),
    ];
    const all = new Set([...rows, ...ties].map((m) => m.text));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      const res = await list(group.id, {
        limit: "3",
        ...(cursor ? { before: cursor } : {}),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<MessagePage>();
      pages += 1;
      seen.push(...idsOf(body.items));
      // 时间线内部倒序
      for (let i = 1; i < body.items.length; i += 1) {
        expect(body.items[i - 1]!.sentAt >= body.items[i]!.sentAt).toBe(true);
      }
      if (pages === 1) {
        // 翻页途中来了一条更新的消息：它在游标之前，后面的页不该出现它、也不该挤掉别的行
        await makeMessage({
          groupId: group.id,
          sentAt: new Date(base.getTime() + 5000),
          text: "newer",
        });
      }
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }

    expect(pages).toBe(3);
    expect(seen).toHaveLength(all.size);
    expect(new Set(seen)).toEqual(all);
    expect(seen).not.toContain("newer");
    // 新消息出现在下一次从头翻的第一页
    const fresh = await list(group.id, { limit: "1" });
    expect(idsOf(fresh.json<MessagePage>().items)).toEqual(["newer"]);
  });

  it("limit：默认 50、上限 200（201 → 400 VALIDATION_ERROR）、0 → 400", async () => {
    const group = await makeGroup();
    await seed(group.id, 51);

    const byDefault = await list(group.id);
    expect(byDefault.json<MessagePage>().items).toHaveLength(50);
    expect(byDefault.json<MessagePage>().nextCursor).not.toBeNull();

    const max = await list(group.id, { limit: "200" });
    expect(max.statusCode).toBe(200);
    expect(max.json<MessagePage>().items).toHaveLength(51);
    expect(max.json<MessagePage>().nextCursor).toBeNull();

    for (const limit of ["201", "0", "abc"]) {
      const res = await list(group.id, { limit });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("边界：before 游标解不开 → 422 VALIDATION_ERROR", async () => {
    const group = await makeGroup();
    for (const before of [
      "not-base64!!",
      Buffer.from("no-separator").toString("base64url"),
      Buffer.from("not-a-date|x").toString("base64url"),
    ]) {
      const res = await list(group.id, { before });
      expect(res.statusCode).toBe(422);
      expect(res.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("边界：群不存在 → 404 GROUP_NOT_FOUND；空群 → items [] / nextCursor null", async () => {
    const missing = await list("no-such-group");
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ErrorBody>().error.code).toBe("GROUP_NOT_FOUND");

    const group = await makeGroup();
    const empty = await list(group.id);
    expect(empty.statusCode).toBe(200);
    expect(empty.json<MessagePage>()).toEqual({ items: [], nextCursor: null });
  });

  it("数据范围：只返回该群的消息，别的群的不混进来", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    await seed(a.id, 2);
    await seed(b.id, 3);
    const res = await list(a.id);
    expect(res.json<MessagePage>().items).toHaveLength(2);
  });

  it("闸门：没带 token → 401 UNAUTHORIZED", async () => {
    const group = await makeGroup();
    const res = await list(group.id, {}, {});
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe("UNAUTHORIZED");
  });
});
