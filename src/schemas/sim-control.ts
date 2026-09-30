// 演示用模拟控制（后端 #46）的 zod schema：控制台代推一条「外部成员发言」到网关模拟器。
import { z } from "zod";

export const SimControlsRead = z
  .object({
    /** SIM_CONTROLS_ENABLED 是否打开；关着时控制台不显示入口 */
    enabled: z.boolean(),
  })
  .meta({ id: "SimControlsRead" });
export type SimControlsRead = z.infer<typeof SimControlsRead>;

/** 附带图片的原始字节上限（后端 #59）：前端 nginx 的 client_max_body_size 是 2m，base64 膨胀 1/3 */
export const SIMULATE_MEDIA_MAX_BYTES = 1024 * 1024;

export const SimulateMediaType = z
  .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
  .meta({ id: "SimulateMediaType" });

export const SimulateInboundRequest = z.object({
  /** 外部成员在网关上的用户 ID（不能是本平台托管账号的 platformUserId） */
  senderPlatformUserId: z.string().trim().min(1).max(64),
  /** 带图片时可以只有一两个字（例如「看图」）；不能全空 */
  text: z.string().trim().min(1).max(2000),
  /** 可选的一张图片（base64，不带 data: 前缀），经模拟器生成 mediaUrl，走题目 C1 的下载链路 */
  media: z
    .object({
      contentType: SimulateMediaType,
      base64: z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64 不合法")
        .refine(
          (b) => Math.floor((b.length * 3) / 4) <= SIMULATE_MEDIA_MAX_BYTES,
          "图片不能超过 1 MB",
        ),
    })
    .optional(),
});
export type SimulateInboundRequest = z.infer<typeof SimulateInboundRequest>;

/** 202：模拟器已收下；消息随后经事件流进入时间线（与真实外部发言同一条路） */
export const SimulateInboundResponse = z
  .object({
    gatewayGroupId: z.string(),
  })
  .meta({ id: "SimulateInboundResponse" });
