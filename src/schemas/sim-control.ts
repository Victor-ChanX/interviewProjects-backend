// 演示用模拟控制（后端 #46）的 zod schema：控制台代推一条「外部成员发言」到网关模拟器。
import { z } from "zod";

export const SimControlsRead = z
  .object({
    /** SIM_CONTROLS_ENABLED 是否打开；关着时控制台不显示入口 */
    enabled: z.boolean(),
  })
  .meta({ id: "SimControlsRead" });
export type SimControlsRead = z.infer<typeof SimControlsRead>;

export const SimulateInboundRequest = z.object({
  /** 外部成员在网关上的用户 ID（不能是本平台托管账号的 platformUserId） */
  senderPlatformUserId: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(2000),
});
export type SimulateInboundRequest = z.infer<typeof SimulateInboundRequest>;

/** 202：模拟器已收下；消息随后经事件流进入时间线（与真实外部发言同一条路） */
export const SimulateInboundResponse = z
  .object({
    gatewayGroupId: z.string(),
  })
  .meta({ id: "SimulateInboundResponse" });
