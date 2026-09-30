import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { authHeaders, makeExample } from "./factories.js";
import { truncateAll } from "./setup.js";

describe("health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/health 返回 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});

describe("examples", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  beforeEach(truncateAll);

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("主流程：创建后能列出、能按 id 取到", async () => {
    const created = await makeExample(app, { name: "first" });
    const list = await app.inject({
      method: "GET",
      url: "/api/examples",
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [{ id: created.id, name: "first", status: "active" }],
    });

    const one = await app.inject({
      method: "GET",
      url: `/api/examples/${created.id}`,
      headers: authHeaders(),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: created.id, name: "first" });
  });

  it("边界：重名创建返回 409 信封（P2002 → Conflict）", async () => {
    await makeExample(app, { name: "dup" });
    const res = await app.inject({
      method: "POST",
      url: "/api/examples",
      headers: authHeaders("u1", ["admin"]),
      payload: { name: "dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: "EXAMPLE_NAME_TAKEN" },
    });
  });

  it("边界：不存在的 id 返回 404 信封", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/examples/999999",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "EXAMPLE_NOT_FOUND" } });
  });
});
