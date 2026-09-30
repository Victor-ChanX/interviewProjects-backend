// 演示用模拟控制（后端 #46）：控制台代推一条「外部成员发言」。
//
// 为什么要有：线上演示时网关是模拟器（src/sim/gateway），外部成员发言只能打它的 /_sim/push，而那个接口没有鉴权、
// 只在内网暴露 —— 评审拿到演示地址也没法触发 Agent。这里由后端（admin 闸门之后）代为调用。
//
// 只推到模拟器、不直接写库：消息照常经 SSE 事件流 → 入站 worker → 时间线 / Agent 触发，走的是和真实外部发言
// 完全相同的路径，演示看到的就是系统真实的行为。
//
// 开关 SIM_CONTROLS_ENABLED（默认关）：关着时 simControlClientFromConfig() 返回 null，端点一律 409，
// 后端不碰 /_sim/*。真网关没有这个接口，所以只该在 GATEWAY_URL 指向模拟器时打开。
import { config } from "../core/config.js";
import {
  ServiceUnavailable,
  Conflict,
  Invalid,
  NotFound,
} from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { getDb } from "../db/client.js";
import type {
  SimControlsRead,
  SimulateInboundRequest,
} from "../schemas/sim-control.js";

/** 调网关模拟器 /_sim/* 的客户端；null = 开关关着 */
export type SimControlClient = {
  pushExternalMessage(input: {
    gatewayGroupId: string;
    senderPlatformUserId: string;
    text: string;
  }): Promise<void>;
};

const SIM_TIMEOUT_MS = 5_000;

export function createSimControlClient(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
}): SimControlClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async pushExternalMessage(input) {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/_sim/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "message",
            groupId: input.gatewayGroupId,
            senderPlatformUserId: input.senderPlatformUserId,
            text: input.text,
          }),
          signal: AbortSignal.timeout(SIM_TIMEOUT_MS),
        });
      } catch {
        throw new ServiceUnavailable(
          "GATEWAY_ERROR",
          "连不上网关模拟器（GATEWAY_URL），确认它已启动",
        );
      }
      if (!res.ok) {
        throw new ServiceUnavailable(
          "GATEWAY_ERROR",
          res.status === 404
            ? "网关模拟器不认识这个群，或 GATEWAY_URL 指向的不是模拟器"
            : `网关模拟器拒绝了这次推送（HTTP ${res.status}）`,
          { status: res.status },
        );
      }
    },
  };
}

/** 生产用：开关关着返回 null；开着时指向 GATEWAY_URL（缺了同样视为不可用） */
export function simControlClientFromConfig(): SimControlClient | null {
  if (!config.simControlsEnabled || !config.gatewayUrl) return null;
  return createSimControlClient({ baseUrl: config.gatewayUrl });
}

export function getSimControls(
  client: SimControlClient | null,
): SimControlsRead {
  return { enabled: client !== null };
}

/**
 * 以外部成员身份往群里推一条消息（经模拟器，异步进入时间线）。
 * 拒绝：开关关着 409 SIM_CONTROLS_DISABLED · 群不存在 404 · 群还没在网关建好 / 已退出 409 GROUP_UNREACHABLE ·
 * 发送者是本平台托管账号 422 SIM_SENDER_IS_MANAGED · 模拟器不可达 / 拒绝 503 GATEWAY_ERROR。
 */
export async function simulateInbound(
  groupId: string,
  input: SimulateInboundRequest,
  deps: {
    client: SimControlClient | null;
    log?: Pick<Logger, "info">;
  },
): Promise<{ gatewayGroupId: string }> {
  if (!deps.client) {
    throw new Conflict(
      "SIM_CONTROLS_DISABLED",
      "模拟控制没有打开：后端设置 SIM_CONTROLS_ENABLED=1 并重新部署后可用",
    );
  }
  const db = getDb();
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: { status: true, gatewayGroupId: true },
  });
  if (!group) {
    throw new NotFound("GROUP_NOT_FOUND", "群不存在或已被删除", { groupId });
  }
  if (group.status !== "active" || group.gatewayGroupId === null) {
    throw new Conflict(
      "GROUP_UNREACHABLE",
      group.status === "active"
        ? "群尚未在网关建好，稍后再试"
        : `群已${group.status === "left" ? "退出" : "不可写"}，收不到新消息`,
      { groupId, status: group.status },
    );
  }
  const managed = await db.account.findFirst({
    where: { platformUserId: input.senderPlatformUserId },
    select: { id: true },
  });
  if (managed) {
    throw new Invalid(
      "SIM_SENDER_IS_MANAGED",
      `${input.senderPlatformUserId} 是本平台托管的账号 ${managed.id}，外部成员发言请换一个 ID；以托管账号发言请用「发送」`,
      { accountId: managed.id },
    );
  }
  await deps.client.pushExternalMessage({
    gatewayGroupId: group.gatewayGroupId,
    senderPlatformUserId: input.senderPlatformUserId,
    text: input.text,
  });
  deps.log?.info(
    {
      groupId,
      gatewayGroupId: group.gatewayGroupId,
      senderPlatformUserId: input.senderPlatformUserId,
    },
    "已代推一条模拟的外部成员发言",
  );
  return { gatewayGroupId: group.gatewayGroupId };
}
