// 领域异常：services 用 throw 表达「拒绝」，src/app.ts 的 setErrorHandler
// 统一映射成错误信封 { error: { code, message, requestId, ...extra } }。
// 路由里不许手写 reply.code(4xx).send(...)。
// 请求形状错（zod 校验失败）不是领域异常：setErrorHandler 直接出 400 VALIDATION_ERROR（题目 2.3）；
// 这里的 Invalid（422）留给「形状对、业务上不成立」的拒绝。
//
// ErrorCode 是联合类型：新增机器码必须在这里登记，tsc 保证不会有漏网的字面量。

export type ErrorCode =
  | "UNAUTHORIZED"
  // 同一用户名短时间内登录失败太多次（429，后端 #56）：等 retryAfterSeconds 再试
  | "LOGIN_THROTTLED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "INTERNAL"
  // ---- 账号（#6，题目 2.3 accounts 端点 + A1）----
  | "ACCOUNT_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "CAS_CONFLICT"
  | "ACCOUNT_UNAVAILABLE"
  // 网关整体不可用 / 网络错（503）：不是业务拒绝，前端按它提示「稍后再试」
  | "GATEWAY_ERROR"
  // ---- 群消息时间线（#9，题目 2.3 GET /api/groups/:id/messages）----
  | "GROUP_NOT_FOUND"
  // ---- 出站 outbox（#7，题目 2.3 POST /api/groups/:id/send + A2）----
  // 账号不是该群成员（409：等 member_joined 到了状态就变）
  | "ACCOUNT_NOT_IN_GROUP"
  // 群已 unreachable / left：不再受理发送（409：群状态不允许）
  | "GROUP_UNREACHABLE"
  // ---- 建群 job（#11，题目 2.3 POST /api/groups + GET /api/jobs/:jobId）----
  // 建群涉及的账号不是 online（含不存在的账号；422：换一批账号就能过）
  | "ACCOUNT_NOT_ONLINE"
  | "JOB_NOT_FOUND"
  // ---- Agent run（#13，题目 2.3 GET /api/agent-runs/:id）----
  | "AGENT_RUN_NOT_FOUND"
  // ---- leave-all job（#16，题目 2.3 POST /api/groups/:id/leave-all + B2）----
  // 群已是 left：没有成员可退（409：状态不允许，请求本身没问题）
  | "GROUP_ALREADY_LEFT"
  // 群在网关里还没建成（gatewayGroupId 为空：建群 job 未完成或已失败），没有可退的群（409：等状态变）
  | "GROUP_NOT_READY"
  // 该群已有一个 running 的 job（建群还在跑 / 已有 leave-all 在跑）；部分唯一索引撞出的 P2002 → 409
  | "JOB_ALREADY_RUNNING"
  // ---- 定时序列（#15，题目 B1 + 2.3 sequences / sequence-runs 端点）----
  // 请求体里的 sequenceId 不存在（422：换一个 id 就能过；不是路径资源，不用 404）
  | "SEQUENCE_NOT_FOUND"
  | "SEQUENCE_RUN_NOT_FOUND"
  // 同群已有 running 的序列运行（409：部分唯一索引撞出来的，等它结束）
  | "SEQUENCE_ALREADY_RUNNING"
  // 预检：某步文本里的 {key} 解析不到（422；extra 带 stepIndex / key）
  | "UNRESOLVED_PLACEHOLDER"
  // ---- LLM 设置（#19，题目 C2：控制台配置 llm-agent 的上游）----
  // 没带 apiKey 且 baseUrl 与已保存的不同：不能把已存的 key 发给另一个主机（422：填上 key 就能过）
  | "LLM_API_KEY_REQUIRED"
  // 服务商对这个 key 回 401 / 403（422：换个 key 就能过）
  | "LLM_UPSTREAM_UNAUTHORIZED"
  // 服务商或 llm-agent 不可用、超时、回了不可理解的东西（503）
  | "LLM_UPSTREAM_ERROR"
  // AGENT_URL 指向的服务没有管理端点（例如 Agent 模拟器），或没配 LLM_AGENT_ADMIN_TOKEN（409：切到 llm-agent 后就能用）
  | "LLM_AGENT_UNSUPPORTED"
  // ---- 异常中心（#22，题目 A2「让操作员看到」：GET /api/inconsistencies/:id、POST …/resolve）----
  | "INCONSISTENCY_NOT_FOUND"
  // ---- 演示用模拟控制（后端 #46：控制台代推外部成员发言）----
  // SIM_CONTROLS_ENABLED 没开（409：开关打开并重新部署后就能用）
  | "SIM_CONTROLS_DISABLED"
  // ---- 就绪检查（#57，GET /api/health/ready）：数据库 / schema / 调度器心跳有一项不行（503）----
  | "NOT_READY"
  // 指定的发送者是本平台托管的账号（422：外部成员发言不能冒用自己的账号，自己发走 /send）
  | "SIM_SENDER_IS_MANAGED"
  /** 没有这个接口（未匹配的路由） */
  | "ROUTE_NOT_FOUND";

export type ErrorExtra = Record<string, unknown>;

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly extra: ErrorExtra;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    extra: ErrorExtra = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

/** 401：没有身份（没带 token / token 无效） */
export class Unauthorized extends DomainError {
  constructor(
    code: ErrorCode = "UNAUTHORIZED",
    message = "未登录或凭证无效",
    extra?: ErrorExtra,
  ) {
    super(401, code, message, extra);
  }
}

/** 403：有身份但没权限（对象存在，且调用方被允许知道它存在） */
export class Forbidden extends DomainError {
  constructor(
    code: ErrorCode = "FORBIDDEN",
    message = "没有权限执行此操作",
    extra?: ErrorExtra,
  ) {
    super(403, code, message, extra);
  }
}

/** 404：对象不存在，或调用方不该知道它存在 */
export class NotFound extends DomainError {
  constructor(code: ErrorCode, message: string, extra?: ErrorExtra) {
    super(404, code, message, extra);
  }
}

/** 409：与现有状态冲突（重名、状态机非法转移、并发已被别人抢先） */
export class Conflict extends DomainError {
  constructor(code: ErrorCode, message: string, extra?: ErrorExtra) {
    super(409, code, message, extra);
  }
}

/** 429：请求太频繁（登录节流）；extra 里带 retryAfterSeconds */
export class TooManyRequests extends DomainError {
  constructor(code: ErrorCode, message: string, extra?: ErrorExtra) {
    super(429, code, message, extra);
  }
}

/** 422：输入本身在语义上不成立（格式对但业务上不合法；纯形状错是 400，由 setErrorHandler 处理） */
export class Invalid extends DomainError {
  constructor(
    code: ErrorCode = "VALIDATION_ERROR",
    message = "请求参数不合法",
    extra?: ErrorExtra,
  ) {
    super(422, code, message, extra);
  }
}

/**
 * 503：请求本身没问题，是依赖的外部服务（消息网关 / 网关模拟器 / Agent 服务 / 模型服务商）不可用或回了不可理解的东西。
 * 不是业务拒绝，前端按它提示「稍后再试」；结果未知的外部调用不在这里翻译，走 outbox 的 unknown。
 * 为什么不用 502：线上站点走 Cloudflare，源站的 502 响应体会被 Cloudflare 整个换成它自己的错误页，
 * message 里写给人看的原因到不了控制台（后端 #50）；503 原样转发。
 */
export class ServiceUnavailable extends DomainError {
  constructor(
    code: ErrorCode = "GATEWAY_ERROR",
    message = "外部服务暂时不可用，请稍后再试",
    extra?: ErrorExtra,
  ) {
    super(503, code, message, extra);
  }
}
