// 领域异常：services 用 throw 表达「拒绝」，src/app.ts 的 setErrorHandler
// 统一映射成错误信封 { error: { code, message, requestId, ...extra } }。
//
// ErrorCode 是联合类型：新增机器码必须在这里登记，tsc 保证不会有漏网的字面量。

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "INTERNAL"
  | "EXAMPLE_NOT_FOUND"
  | "EXAMPLE_NAME_TAKEN";

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

/** 422：输入本身在语义上不成立（格式对但业务上不合法） */
export class Invalid extends DomainError {
  constructor(
    code: ErrorCode = "VALIDATION_ERROR",
    message = "请求参数不合法",
    extra?: ErrorExtra,
  ) {
    super(422, code, message, extra);
  }
}
