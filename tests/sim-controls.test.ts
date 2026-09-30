// 演示用模拟控制（后端 #46）：GET /api/sim-controls、POST /api/groups/:id/simulate-inbound。
// 网关用 src/sim/gateway 起在 listen(0) 上，应用经 createSimControlClient({ baseUrl }) 真 HTTP 调它的 /_sim/push；
// 断言看模拟器的 /_sim/state（消息确实进了网关、之后照常经事件流下发），不直接查本地库 —— 本端点不写库。
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import {
  createGatewayClient,
  type GatewayClient,
} from "../src/services/gateway-client.js";
import { createSimControlClient } from "../src/services/sim-control-service.js";
import { buildGatewayApp } from "../src/sim/gateway/app.js";
import { loginAs, makeAccount, makeGroup } from "./factories.js";
import { truncateAll } from "./setup.js";

type ErrorBody = { error: { code: string; message: string } };
type SimState = {
  messages: { groupId: string; senderPlatformUserId: string; text: string }[];
};

describe("模拟外部成员发言（#46）", () => {
  let app: FastifyInstance;
  let disabledApp: FastifyInstance;
  let gateway: FastifyInstance;
  let gatewayClient: GatewayClient;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    gateway = await buildGatewayApp({ logger: false });
    const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
    gatewayClient = createGatewayClient({ baseUrl: url });
    app = await buildApp({
      logger: false,
      gateway: gatewayClient,
      simControl: createSimControlClient({ baseUrl: url }),
    });
    disabledApp = await buildApp({ logger: false, simControl: null });
    await Promise.all([app.ready(), disabledApp.ready()]);
  });

  beforeEach(async () => {
    await truncateAll();
    await gateway.inject({ method: "POST", url: "/_sim/reset" });
    admin = await loginAs(app, "admin");
    viewer = await loginAs(app, "viewer");
  });

  afterAll(async () => {
    await app.close();
    await disabledApp.close();
    await gateway.close();
    await closeDb();
  });

  /** 在模拟器上真建一个群，本地记录指向它 */
  async function activeGroup() {
    const owner = await makeAccount({ id: "acc-owner" });
    await gatewayClient.connect(owner.id);
    const { groupId: gatewayGroupId } = await gatewayClient.createGroup({
      creatorAccountId: owner.id,
    });
    const group = await makeGroup({
      creatorAccountId: owner.id,
      gatewayGroupId,
    });
    return { group, gatewayGroupId, owner };
  }

  const simState = async (): Promise<SimState> =>
    (await gateway.inject({ method: "GET", url: "/_sim/state" })).json();

  const push = (
    target: FastifyInstance,
    groupId: string,
    body: unknown,
    headers: Record<string, string> = admin,
  ) =>
    target.inject({
      method: "POST",
      url: `/api/groups/${groupId}/simulate-inbound`,
      headers,
      payload: body as Record<string, unknown>,
    });

  it("主流程：admin 代推一条外部发言 → 202，模拟器里多了这条消息（发送者、群、内容都对）", async () => {
    const { group, gatewayGroupId } = await activeGroup();
    const res = await push(app, group.id, {
      senderPlatformUserId: "ext-alice",
      text: "请问活动几点开始？",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ gatewayGroupId });
    expect((await simState()).messages).toEqual([
      expect.objectContaining({
        groupId: gatewayGroupId,
        senderPlatformUserId: "ext-alice",
        text: "请问活动几点开始？",
      }),
    ]);
  });

  it("开关：GET /api/sim-controls 按注入的客户端回 enabled；关着时代推 409 SIM_CONTROLS_DISABLED、不碰模拟器", async () => {
    const on = await app.inject({
      method: "GET",
      url: "/api/sim-controls",
      headers: viewer,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true });

    const offAdmin = await loginAs(disabledApp, "admin");
    const off = await disabledApp.inject({
      method: "GET",
      url: "/api/sim-controls",
      headers: offAdmin,
    });
    expect(off.json()).toEqual({ enabled: false });

    const { group } = await activeGroup();
    const res = await push(
      disabledApp,
      group.id,
      { senderPlatformUserId: "ext-alice", text: "hi" },
      offAdmin,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json<ErrorBody>().error.code).toBe("SIM_CONTROLS_DISABLED");
    expect((await simState()).messages).toEqual([]);
  });

  it("闸门：不带 token 401；viewer 403（请求体不合法也先拿到 403）", async () => {
    const { group } = await activeGroup();
    const anon = await push(app, group.id, { text: "x" }, {});
    expect(anon.statusCode).toBe(401);
    const res = await push(app, group.id, { text: "" }, viewer);
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.code).toBe("FORBIDDEN");
    expect((await simState()).messages).toEqual([]);
  });

  it("业务边界：发送者是本平台托管账号 → 422 SIM_SENDER_IS_MANAGED；空内容 → 400", async () => {
    const { group, owner } = await activeGroup();
    const managed = await push(app, group.id, {
      senderPlatformUserId: owner.platformUserId,
      text: "冒充群主",
    });
    expect(managed.statusCode).toBe(422);
    expect(managed.json<ErrorBody>().error.code).toBe("SIM_SENDER_IS_MANAGED");

    const empty = await push(app, group.id, {
      senderPlatformUserId: "ext-alice",
      text: "   ",
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ErrorBody>().error.code).toBe("VALIDATION_ERROR");
    expect((await simState()).messages).toEqual([]);
  });

  it("状态：群不存在 404；已退出 / 还没在网关建好 409 GROUP_UNREACHABLE", async () => {
    const missing = await push(app, "00000000-0000-0000-0000-000000000000", {
      senderPlatformUserId: "ext-alice",
      text: "hi",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ErrorBody>().error.code).toBe("GROUP_NOT_FOUND");

    const { gatewayGroupId } = await activeGroup();
    const left = await makeGroup({
      status: "left",
      gatewayGroupId: `${gatewayGroupId}-left`,
    });
    const notReady = await makeGroup({ gatewayGroupId: null });
    for (const g of [left, notReady]) {
      const res = await push(app, g.id, {
        senderPlatformUserId: "ext-alice",
        text: "hi",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorBody>().error.code).toBe("GROUP_UNREACHABLE");
    }
    expect((await simState()).messages).toEqual([]);
  });

  it("模拟器不认识这个群（换过网关 / 模拟器重启清空）→ 502 GATEWAY_ERROR", async () => {
    const group = await makeGroup({ gatewayGroupId: "g_not_on_simulator" });
    const res = await push(app, group.id, {
      senderPlatformUserId: "ext-alice",
      text: "hi",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<ErrorBody>().error.code).toBe("GATEWAY_ERROR");
  });
});
