// issue #5：登录 / JWT / 闸门 / 错误信封 / 健康检查。
// 写端点在别的 issue 里陆续出现，闸门矩阵不绑定具体业务路由：测试里自己注册两条探针路由
// （requireUser 保护的读、requireRole("admin") 保护的写），断言的是闸门与信封本身。
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireRole, requireUser } from "../src/api/guards.js";
import { buildApp } from "../src/app.js";
import type { ErrorEnvelope } from "../src/app.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  checkJwtSecret,
  JWT_SECRET_MIN_LENGTH,
  type Principal,
} from "../src/core/jwt.js";
import {
  UNUSABLE_PASSWORD_HASH,
  verifyPassword,
} from "../src/core/password.js";
import { closeDb, getDb } from "../src/db/client.js";
import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
} from "../src/services/auth-service.js";
import { authHeaders, login, loginAs } from "./factories.js";
import { truncateAll } from "./setup.js";

const PROBE_READ = "/__test/probe";
const PROBE_WRITE = "/__test/probe/write";

/** 探针路由：只在测试进程里注册，不进地图与 openapi。 */
async function probeRoutes(app: FastifyInstance): Promise<void> {
  app.get(PROBE_READ, { onRequest: [requireUser] }, async (req) => ({
    principal: req.principal,
  }));
  app.post(
    PROBE_WRITE,
    { onRequest: [requireUser, requireRole("admin")] },
    async (req) => ({ by: req.principal?.username }),
  );
}

describe("auth", () => {
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

  describe("登录端点", () => {
    it("主流程：admin/admin 登录拿到 accessToken，能过 requireUser，身份是 admin", async () => {
      const headers = await loginAs(app, "admin");
      expect(headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

      const res = await app.inject({ method: "GET", url: PROBE_READ, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        principal: { username: "admin", role: "admin" },
      });
      expect(res.json<{ principal: Principal }>().principal.userId).toEqual(
        expect.any(String),
      );
    });

    it("边界：密码错误 → 401 UNAUTHORIZED", async () => {
      await loginAs(app, "admin"); // 保证用户存在
      const res = await login(app, { username: "admin", password: "wrong" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", message: "用户名或密码错误" },
      });
    });

    it("边界：用户名不存在 → 同样 401 UNAUTHORIZED（不暴露用户名是否存在）", async () => {
      const res = await login(app, { username: "nobody", password: "x" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", message: "用户名或密码错误" },
      });
    });

    it(`节流：同一用户名连续失败 ${LOGIN_MAX_FAILURES} 次 → 429 LOGIN_THROTTLED（带 retryAfterSeconds），锁定期间对的密码也不行`, async () => {
      await loginAs(app, "admin");
      for (let i = 1; i < LOGIN_MAX_FAILURES; i += 1) {
        const r = await login(app, { username: "admin", password: "wrong" });
        expect(r.statusCode).toBe(401);
      }
      const locked = await login(app, { username: "admin", password: "wrong" });
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toMatchObject({
        error: {
          code: "LOGIN_THROTTLED",
          retryAfterSeconds: LOGIN_LOCK_MS / 1000,
        },
      });
      const right = await login(app, { username: "admin", password: "admin" });
      expect(right.statusCode).toBe(429);
      // 别的用户名不受影响
      await loginAs(app, "viewer");
    });

    it("节流：锁过期后能登录，登录成功清掉计数；窗口外的旧失败不累计", async () => {
      await loginAs(app, "admin");
      await getDb().loginThrottle.create({
        data: {
          username: "admin",
          failures: 0,
          windowStartedAt: new Date(Date.now() - LOGIN_LOCK_MS - 1_000),
          lockedUntil: new Date(Date.now() - 1_000),
        },
      });
      const ok = await login(app, { username: "admin", password: "admin" });
      expect(ok.statusCode).toBe(200);
      expect(await getDb().loginThrottle.count()).toBe(0);

      // 窗口外（很久以前）已有 LOGIN_MAX_FAILURES - 1 次失败：这次失败从 1 重新计，不上锁
      await getDb().loginThrottle.create({
        data: {
          username: "admin",
          failures: LOGIN_MAX_FAILURES - 1,
          windowStartedAt: new Date(Date.now() - LOGIN_WINDOW_MS - 60_000),
        },
      });
      const r = await login(app, { username: "admin", password: "wrong" });
      expect(r.statusCode).toBe(401);
      expect(
        (
          await getDb().loginThrottle.findUniqueOrThrow({
            where: { username: "admin" },
          })
        ).failures,
      ).toBe(1);
    });

    it("CORS：默认不放行任何跨域来源（控制台走同源反代）", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "https://evil.test" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("用户名不存在也跑一遍 scrypt：占位哈希格式合法、任何口令都验不过", async () => {
      expect(UNUSABLE_PASSWORD_HASH.split("$")).toHaveLength(6);
      expect(await verifyPassword("admin", UNUSABLE_PASSWORD_HASH)).toBe(false);
      expect(await verifyPassword("", UNUSABLE_PASSWORD_HASH)).toBe(false);
    });

    it("JWT_SECRET 缺失或短于 32 个字符：拒绝签发（启动即失败）", () => {
      expect(() => checkJwtSecret(undefined)).toThrow(/缺少/);
      expect(() =>
        checkJwtSecret("x".repeat(JWT_SECRET_MIN_LENGTH - 1)),
      ).toThrow(/太短/);
      const ok = "x".repeat(JWT_SECRET_MIN_LENGTH);
      expect(checkJwtSecret(ok)).toBe(ok);
    });

    it("边界：请求体形状错 → 400 VALIDATION_ERROR，带 issues", async () => {
      const res = await login(app, { username: "admin" });
      expect(res.statusCode).toBe(400);
      const body = res.json<ErrorEnvelope>();
      expect(body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(body.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/password" }),
        ]),
      );
    });
  });

  describe("requireUser", () => {
    it("没带 Bearer → 401 UNAUTHORIZED", async () => {
      const res = await app.inject({ method: "GET", url: PROBE_READ });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });

    it("过期的 token → 401 UNAUTHORIZED（reason: expired）", async () => {
      // 用假时钟把签发时刻拨到 TTL 之前一秒：签出来就是过期的
      const past = new Date(Date.now() - (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);
      const headers = await authHeaders("u1", ["admin"], {
        clock: { now: () => past },
      });
      const res = await app.inject({ method: "GET", url: PROBE_READ, headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "expired" },
      });
    });

    it("刚好还没过期的 token 能用（TTL 是 15 分钟）", async () => {
      const almost = new Date(
        Date.now() - (ACCESS_TOKEN_TTL_SECONDS - 5) * 1000,
      );
      const headers = await authHeaders("u1", [], {
        clock: { now: () => almost },
      });
      const res = await app.inject({ method: "GET", url: PROBE_READ, headers });
      expect(res.statusCode).toBe(200);
    });

    it("签名被篡改 / 乱七八糟的 token → 401 UNAUTHORIZED", async () => {
      const good = (await authHeaders("u1", ["admin"])).authorization!;
      const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
      for (const authorization of [tampered, "Bearer not.a.jwt", "Bearer "]) {
        const res = await app.inject({
          method: "GET",
          url: PROBE_READ,
          headers: { authorization },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
      }
    });

    it("提升角色：篡改 payload 里的 role 后签名对不上 → 401", async () => {
      const [, token] = (await authHeaders("u1", [])).authorization!.split(" ");
      const [h, p, s] = token!.split(".");
      const payload = JSON.parse(
        Buffer.from(p!, "base64url").toString(),
      ) as Record<string, unknown>;
      const forged = Buffer.from(
        JSON.stringify({ ...payload, role: "admin" }),
      ).toString("base64url");
      const res = await app.inject({
        method: "POST",
        url: PROBE_WRITE,
        headers: { authorization: `Bearer ${h}.${forged}.${s}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", reason: "bad_signature" },
      });
    });
  });

  describe("requireRole(admin)：viewer 只读", () => {
    it("viewer 调写端点 → 403 FORBIDDEN；读端点照常 200", async () => {
      const viewer = await loginAs(app, "viewer");
      const write = await app.inject({
        method: "POST",
        url: PROBE_WRITE,
        headers: viewer,
      });
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({
        error: { code: "FORBIDDEN", requiredRole: "admin" },
      });

      const read = await app.inject({
        method: "GET",
        url: PROBE_READ,
        headers: viewer,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ principal: { role: "viewer" } });
    });

    it("admin 调写端点 → 200", async () => {
      const admin = await loginAs(app, "admin");
      const res = await app.inject({
        method: "POST",
        url: PROBE_WRITE,
        headers: admin,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ by: "admin" });
    });

    it("闸门先于请求体校验：viewer 带非法请求体调真实写端点 → 403（不是 400）；未登录 → 401", async () => {
      const viewer = await loginAs(app, "viewer");
      const asViewer = await app.inject({
        method: "POST",
        url: "/api/groups",
        headers: viewer,
        payload: { memberAccountIds: "not-an-array" },
      });
      expect(asViewer.statusCode).toBe(403);
      expect(asViewer.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      const anon = await app.inject({
        method: "POST",
        url: "/api/groups",
        payload: {},
      });
      expect(anon.statusCode).toBe(401);
    });

    it("没登录直接调写端点 → 401（不是 403：先分清是谁）", async () => {
      const res = await app.inject({ method: "POST", url: PROBE_WRITE });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    });
  });

  describe("错误信封", () => {
    it("requestId 沿用网关传来的 x-request-id，并在响应头回显", async () => {
      const res = await app.inject({
        method: "GET",
        url: PROBE_READ,
        headers: { "x-request-id": "gw-abc-123" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", requestId: "gw-abc-123" },
      });
      expect(res.headers["x-request-id"]).toBe("gw-abc-123");
    });

    it("请求体解析失败（声明 JSON 却是空体 / 坏 JSON）→ 400 VALIDATION_ERROR，不是 500", async () => {
      for (const payload of ["", "{bad"]) {
        const res = await app.inject({
          method: "POST",
          url: PROBE_WRITE,
          headers: {
            ...(await authHeaders("u1", ["admin"])),
            "content-type": "application/json",
          },
          payload,
        });
        expect(res.statusCode).toBe(400);
        const { error } = res.json<{
          error: { code: string; reason: string };
        }>();
        expect(error.code).toBe("VALIDATION_ERROR");
        expect(error.reason).toMatch(/^FST_ERR_/);
      }
    });

    it("没有这个接口 → 404 ROUTE_NOT_FOUND，同样是错误信封", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/no-such-thing?x=1",
        headers: { "x-request-id": "gw-404" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: {
          code: "ROUTE_NOT_FOUND",
          message: "没有这个接口：GET /api/no-such-thing",
          requestId: "gw-404",
        },
      });
    });

    it("没传 x-request-id 时自生成，信封与响应头是同一个", async () => {
      const res = await app.inject({ method: "GET", url: PROBE_READ });
      const { requestId } = res.json<ErrorEnvelope>().error;
      expect(requestId).toEqual(expect.any(String));
      expect(requestId.length).toBeGreaterThan(0);
      expect(res.headers["x-request-id"]).toBe(requestId);
    });
  });

  describe("GET /api/health", () => {
    it("公开；返回 { ok: true, schemaVersion: 最新迁移目录名 }", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const dirs = readdirSync(
        fileURLToPath(new URL("../prisma/migrations", import.meta.url)),
        { withFileTypes: true },
      )
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      expect(res.json()).toEqual({ ok: true, schemaVersion: dirs.at(-1) });
      expect(res.json<{ schemaVersion: string }>().schemaVersion).toMatch(
        /^\d{14}_/,
      );
    });
  });
});
