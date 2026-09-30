// 消息网关（题目 2.1）的 HTTP 客户端。只封装本仓当前需要的两个账号端点（connect / disconnect）；
// 群 / 发消息 / 事件流由各自的 issue 往这里加，形状照旧：一个方法一个端点，返回体按题目原样。
//
// - 用全局 fetch（undici）：tests/setup.ts 的 MockAgent 只接管 fetch，node:http / axios 会绕过禁外网。
// - 网关的错误体是 `{ code, message, ...extra }`，这里翻成 GatewayResponseError（带 status / code），
//   业务含义（403 ACCOUNT_SUSPENDED → 账号进终态）由 service 决定，客户端不做状态机判断。
// - 连不上 / 超时 / 非 JSON 是 GatewayUnreachableError：结果未知，service 按「网关不可用」处理。
// - base url 默认取 config.gatewayUrl（GATEWAY_URL）；测试把假网关（src/sim/gateway，listen(0)）的
//   地址传进 createGatewayClient，并经 app.decorate("gateway", …) 注入路由（见 src/api/routes/accounts.ts）。
import { config } from "../core/config.js";

export type GatewayClient = {
  /** POST /accounts/:accountId/connect → { platformUserId }（同一账号每次相同） */
  connect(accountId: string): Promise<{ platformUserId: string }>;
  /** POST /accounts/:accountId/disconnect → 账号离线 */
  disconnect(accountId: string): Promise<void>;
};

/** 网关明确回了 4xx / 5xx：status 与体里的 code 都给 service 分支用。 */
export class GatewayResponseError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    const code = codeOf(body) ?? `HTTP_${status}`;
    super(`网关 ${method} ${path} 返回 ${status} ${code}`);
    this.name = "GatewayResponseError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 连不上 / 超时 / 响应不是 JSON：结果未知。 */
export class GatewayUnreachableError extends Error {
  constructor(method: string, path: string, cause: unknown) {
    super(`网关 ${method} ${path} 请求失败`, { cause });
    this.name = "GatewayUnreachableError";
  }
}

function codeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export type CreateGatewayClientOptions = {
  baseUrl: string;
  /** 默认全局 fetch；测试可注入 */
  fetch?: typeof fetch;
  /** 单次请求超时（AbortSignal.timeout），默认 10s */
  timeoutMs?: number;
};

export function createGatewayClient(
  opts: CreateGatewayClientOptions,
): GatewayClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function post(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GatewayUnreachableError("POST", path, err);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch (err) {
      if (res.ok) throw new GatewayUnreachableError("POST", path, err);
      body = text;
    }
    if (!res.ok) throw new GatewayResponseError("POST", path, res.status, body);
    return body;
  }

  return {
    async connect(accountId) {
      const body = await post(
        `/accounts/${encodeURIComponent(accountId)}/connect`,
      );
      const platformUserId = (body as { platformUserId?: unknown })
        .platformUserId;
      if (typeof platformUserId !== "string" || platformUserId === "") {
        throw new GatewayUnreachableError(
          "POST",
          `/accounts/${accountId}/connect`,
          new Error("响应缺少 platformUserId"),
        );
      }
      return { platformUserId };
    },
    async disconnect(accountId) {
      await post(`/accounts/${encodeURIComponent(accountId)}/disconnect`);
    },
  };
}

/**
 * 生产用：base url 来自 GATEWAY_URL。惰性：缺了在**第一次调网关**时报错，而不是路由插件装载时 ——
 * 生成地图 / 导 openapi（PROJECT_MAP_BUILD=1）与不碰网关的测试都会 ready() 这个 app，那时没有 GATEWAY_URL。
 */
export function gatewayClientFromConfig(): GatewayClient {
  let real: GatewayClient | undefined;
  const resolve = (): GatewayClient => {
    if (!real) {
      if (!config.gatewayUrl) {
        throw new Error("缺少 GATEWAY_URL：调消息网关需要它");
      }
      real = createGatewayClient({ baseUrl: config.gatewayUrl });
    }
    return real;
  };
  return {
    connect: (accountId) => resolve().connect(accountId),
    disconnect: (accountId) => resolve().disconnect(accountId),
  };
}
