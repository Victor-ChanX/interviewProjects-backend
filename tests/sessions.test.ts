// issue #17（题目 2.3 login 行 + B3）：refresh token 轮换、复用作废、logout 即失效。
// 受保护端点用测试内注册的探针路由（requireUser），不绑定具体业务路由：断言的是会话本身。
// 并发 refresh 用 Promise.all 让两次 inject 真正并行（各自的 $transaction 各占一条池连接）。
import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireUser } from "../src/api/guards.js";
import { buildApp } from "../src/app.js";
import type { ErrorEnvelope } from "../src/app.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../src/services/auth-service.js";
import {
  authHeaders,
  login,
  loginSession,
  logout,
  makeSession,
  refresh,
  refreshCookieFrom,
} from "./factories.js";
import { truncateAll } from "./setup.js";

const PROBE = "/__test/session-probe";

async function probeRoutes(app: FastifyInstance): Promise<void> {
  app.get(PROBE, { preHandler: [requireUser] }, async (req) => ({
    userId: req.principal?.userId,
    sessionId: req.principal?.sessionId,
  }));
}

/** 与 service 同一种哈希（sha256 hex）：断言库里存的是哈希、不是原文 */
const sha256 = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

describe("sessions（#17）", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.register(probeRoutes);
    await app.ready();
  });

  beforeEach(truncateAll);

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const probe = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: PROBE, headers });
  const bearer = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
  });

  describe("login", () => {
    it("主流程：refresh token 只在 HttpOnly cookie 里，响应体只有 accessToken；库里只存 sha256", async () => {
      const session = await loginSession(app, "admin");
      // loginSession 已断言 200 与 cookie 存在；再打一次原始端点看属性
      const res = await login(app, { username: "admin", password: "admin" });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json<object>())).toEqual(["accessToken"]);
      expect(res.body).not.toContain("refresh");

      const cookie = refreshCookieFrom(res);
      expect(cookie).toMatchObject({
        name: REFRESH_COOKIE_NAME,
        httpOnly: true,
        sameSite: "Strict",
        path: REFRESH_COOKIE_PATH,
      });
      // 测试不是 production：不带 Secure（本地 http 下带了浏览器根本存不进去）
      expect(cookie?.secure).toBeFalsy();
      expect(cookie?.expires?.getTime()).toBeGreaterThan(
        Date.now() + (REFRESH_TOKEN_TTL_SECONDS - 60) * 1000,
      );

      const rows = await getDb().session.findMany();
      expect(rows).toHaveLength(2); // loginSession + 这一次：两个族
      const hashes = rows.map((r) => r.tokenHash).sort();
      expect(hashes).toEqual(
        [sha256(session.refreshToken), sha256(cookie!.value)].sort(),
      );
      expect(new Set(rows.map((r) => r.tokenFamily)).size).toBe(2);
      for (const row of rows) {
        expect(row.rotatedAt).toBeNull();
        expect(row.revokedAt).toBeNull();
      }

      // access token 的 sid 指向本次的会话行，requireUser 把它挂在 principal 上
      const p = await probe(session.headers);
      expect(p.statusCode).toBe(200);
      const sidRow = rows.find(
        (r) => r.tokenHash === sha256(session.refreshToken),
      );
      expect(p.json()).toEqual({
        userId: sidRow!.userId,
        sessionId: sidRow!.id,
      });
    });
  });

  describe("refresh", () => {
    it("主流程：换出新 access（能用）+ 新 cookie；旧行 rotatedAt、新行同族", async () => {
      const s = await loginSession(app, "viewer");
      const res = await refresh(app, s.refreshToken);
      expect(res.statusCode).toBe(200);
      const { accessToken } = res.json<{ accessToken: string }>();
      expect(accessToken).not.toBe(s.accessToken);
      const cookie = refreshCookieFrom(res);
      expect(cookie).toMatchObject({
        httpOnly: true,
        sameSite: "Strict",
        path: REFRESH_COOKIE_PATH,
      });
      expect(cookie!.value).not.toBe(s.refreshToken);

      expect((await probe(bearer(accessToken))).statusCode).toBe(200);
      // 旧 access 在 15 分钟内照常可用（题目只要求复用 / logout 才作废）
      expect((await probe(s.headers)).statusCode).toBe(200);

      const rows = await getDb().session.findMany({
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toHaveLength(2);
      const [old, fresh] = [rows[0]!, rows[1]!];
      expect(old.tokenHash).toBe(sha256(s.refreshToken));
      expect(old.rotatedAt).not.toBeNull();
      expect(old.revokedAt).toBeNull();
      expect(fresh.tokenHash).toBe(sha256(cookie!.value));
      expect(fresh.tokenFamily).toBe(old.tokenFamily);
      expect(fresh.rotatedAt).toBeNull();
      expect(fresh.revokedAt).toBeNull();
    });

    it("复用作废：旧 refresh 再被使用 → 401 reused，且之前换出的新 refresh 与新 access 立即失效", async () => {
      const s = await loginSession(app, "viewer");
      const first = await refresh(app, s.refreshToken);
      expect(first.statusCode).toBe(200);
      const newAccess = first.json<{ accessToken: string }>().accessToken;
      const newRefresh = refreshCookieFrom(first)!.value;
      expect((await probe(bearer(newAccess))).statusCode).toBe(200);

      const reuse = await refresh(app, s.refreshToken);
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "reused", revokedCount: 2 },
      });
      // 拒绝时不下发新 cookie
      expect(refreshCookieFrom(reuse)).toBeUndefined();

      // 整族作废：新 access 打受保护端点 401，新 refresh 401，旧 access 也 401
      const p = await probe(bearer(newAccess));
      expect(p.statusCode).toBe(401);
      expect(p.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "session_revoked" },
      });
      const r = await refresh(app, newRefresh);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "revoked" },
      });
      expect((await probe(s.headers)).statusCode).toBe(401);

      const rows = await getDb().session.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it("边界：无 cookie → 401；乱写的 cookie → 401 unknown", async () => {
      const none = await refresh(app);
      expect(none.statusCode).toBe(401);
      expect(none.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "unknown" },
      });
      const junk = await refresh(app, "not-a-real-token");
      expect(junk.statusCode).toBe(401);
      expect(junk.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "unknown" },
      });
    });

    it("边界：过期的 refresh → 401 expired，且不作废族（只是到期）", async () => {
      const s = await loginSession(app, "viewer");
      await getDb().session.updateMany({
        where: { tokenHash: sha256(s.refreshToken) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await refresh(app, s.refreshToken);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "expired" },
      });
      const row = await getDb().session.findUniqueOrThrow({
        where: { tokenHash: sha256(s.refreshToken) },
      });
      expect(row.rotatedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
    });

    it("access 过期但 refresh 有效 → 刷新成功，新 access 能用", async () => {
      const raw = "known-refresh-token-for-test";
      const session = await makeSession("u-expired", "viewer", {
        tokenHash: sha256(raw),
      });
      const expired = await authHeaders("u-expired", [], {
        sessionId: session.id,
        ttlSeconds: -1,
      });
      const before = await probe(expired);
      expect(before.statusCode).toBe(401);
      expect(before.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "expired" },
      });

      const res = await refresh(app, raw);
      expect(res.statusCode).toBe(200);
      const after = await probe(
        bearer(res.json<{ accessToken: string }>().accessToken),
      );
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ userId: "u-expired" });
    });

    it("并发：两个 refresh 同用一枚 token → 恰好一个 200；后到的按「旧 token 再被使用」作废整族，先到的换出的也失效", async () => {
      // 题目 B3 的语义：旧 refresh 再被使用 → 整个会话作废。并发时服务端分不清哪个是攻击者，宁可让用户重新登录。
      const s = await loginSession(app, "viewer");
      const [a, b] = await Promise.all([
        refresh(app, s.refreshToken),
        refresh(app, s.refreshToken),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 401]);
      const ok = a.statusCode === 200 ? a : b;
      const lost = a.statusCode === 200 ? b : a;
      expect(lost.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "reused" },
      });

      const won = ok.json<{ accessToken: string }>().accessToken;
      expect((await probe(bearer(won))).statusCode).toBe(401);
      expect(
        (await refresh(app, refreshCookieFrom(ok)!.value)).statusCode,
      ).toBe(401);
      const rows = await getDb().session.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });
  });

  describe("logout", () => {
    it("主流程：200 { ok: true }、清 cookie；同一 access 立即 401、refresh 也 401", async () => {
      const s = await loginSession(app, "admin");
      const res = await logout(app, s.headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const cleared = refreshCookieFrom(res);
      expect(cleared).toBeDefined();
      expect(cleared!.value).toBe("");
      expect(cleared!.path).toBe(REFRESH_COOKIE_PATH);
      expect(cleared!.expires!.getTime()).toBeLessThan(Date.now());

      const p = await probe(s.headers);
      expect(p.statusCode).toBe(401);
      expect(p.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "session_revoked" },
      });
      const r = await refresh(app, s.refreshToken);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "revoked" },
      });
      // 再 logout：access 已作废，先被 requireUser 挡下
      expect((await logout(app, s.headers)).statusCode).toBe(401);
    });

    it("logout 作废的是整族：刷新过一次后用新 access 登出，旧 access 与旧 / 新 refresh 全部失效", async () => {
      const s = await loginSession(app, "viewer");
      const first = await refresh(app, s.refreshToken);
      const newAccess = first.json<{ accessToken: string }>().accessToken;
      const newRefresh = refreshCookieFrom(first)!.value;

      expect((await logout(app, bearer(newAccess))).statusCode).toBe(200);
      expect((await probe(s.headers)).statusCode).toBe(401);
      expect((await probe(bearer(newAccess))).statusCode).toBe(401);
      expect((await refresh(app, newRefresh)).statusCode).toBe(401);
      expect((await refresh(app, s.refreshToken)).statusCode).toBe(401);
      const rows = await getDb().session.findMany();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it("数据范围：同一用户的另一个会话（另一次登录）不受影响", async () => {
      const a = await loginSession(app, "viewer");
      const b = await loginSession(app, "viewer");
      expect((await logout(app, a.headers)).statusCode).toBe(200);
      expect((await probe(a.headers)).statusCode).toBe(401);
      expect((await probe(b.headers)).statusCode).toBe(200);
      expect((await refresh(app, b.refreshToken)).statusCode).toBe(200);
    });

    it("边界：没登录直接 logout → 401", async () => {
      const res = await logout(app, {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });
  });

  describe("requireUser 的会话检查", () => {
    it("签名对但 sid 指向不存在的会话 → 401 session_revoked", async () => {
      const headers = await authHeaders("ghost", [], {
        sessionId: "00000000-0000-0000-0000-000000000000",
      });
      const res = await probe(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorEnvelope>().error).toMatchObject({
        code: "UNAUTHORIZED",
        reason: "session_revoked",
      });
    });

    it("直接在库里作废会话行 → 该 access 立即 401（多副本：别的副本作废的也看得见）", async () => {
      const s = await loginSession(app, "viewer");
      expect((await probe(s.headers)).statusCode).toBe(200);
      await getDb().session.updateMany({ data: { revokedAt: new Date() } });
      expect((await probe(s.headers)).statusCode).toBe(401);
    });
  });
});
