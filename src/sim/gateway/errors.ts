// 网关模拟器的错误体。模拟器是「外部服务」，不走应用的 { error: { code, message, requestId } } 信封：
// 每个 4xx / 5xx 响应体固定是 `{ code, message, ...extra }`，`code` 取题目 2.1 里的机器码
// （ACCOUNT_OFFLINE / INVITE_NOT_READY / RATE_LIMITED …），`extra` 放 429 的 retryAfterSeconds 这类字段。
// 拒绝 = throw GatewayError，由 app.ts 的 setErrorHandler 统一序列化。

export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
