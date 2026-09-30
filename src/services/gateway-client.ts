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
  /**
   * GET /events?since=<eventId>（SSE，#8）：逐帧产出解析后的事件。since 为 null = 不带（只收连接之后的）。
   * 连接被掐断 / 网关回非 2xx 时**抛错**（GatewayUnreachableError / GatewayResponseError），
   * 由入站 worker 带最新游标重连；signal 被 abort 则安静结束（停机）。
   */
  openEventStream(opts: OpenEventStreamOptions): AsyncIterable<GatewayEvent>;
  /**
   * POST /groups/:groupId/send → 202 { accepted: true }（#7）。同步错误全套按 GatewayResponseError 抛：
   * 429 RATE_LIMITED（body.retryAfterSeconds）/ 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED /
   * 403 GROUP_WRITE_FORBIDDEN / 403 SENDER_NOT_IN_GROUP / 409 ACCOUNT_OFFLINE / 504 NETWORK_TIMEOUT / 503。
   */
  send(input: GatewaySendInput): Promise<{ accepted: true }>;
  /**
   * GET /groups/:groupId/messages/by-client-id/:clientMsgId → 200 { msgId, sentAt } / 404 → null（#7）。
   * 503 / 连不上照常抛（GatewayResponseError / GatewayUnreachableError）：查询不可用 ≠ 没发出。
   */
  getMessageByClientId(
    groupId: string,
    clientMsgId: string,
  ): Promise<GatewayMessageLanding | null>;

  // ---- 群与成员（题目 2.1「群与成员」；建群 job #11、kick #12、leave #16）----
  /** POST /groups { creatorAccountId } → { groupId }：创建者即群主与成员，网关不为它推 member_joined。 */
  createGroup(input: {
    creatorAccountId: string;
  }): Promise<{ groupId: string }>;
  /**
   * POST /groups/:groupId/invite → { inviteLink, readyAfterMs }。readyAfterMs 内使用链接得到
   * 409 INVITE_NOT_READY；链接随时可能过期（使用时 410 INVITE_EXPIRED）。
   */
  createInvite(groupId: string): Promise<GatewayInvite>;
  /**
   * POST /groups/:groupId/join { accountId, inviteLink } → 202 { accepted: true }：只是受理，入群以
   * member_joined 事件为准。同步错误按 GatewayResponseError 抛：409 ALREADY_MEMBER / 409 INVITE_NOT_READY /
   * 410 INVITE_EXPIRED / 409 ACCOUNT_OFFLINE。
   */
  joinGroup(
    groupId: string,
    input: { accountId: string; inviteLink: string },
  ): Promise<{ accepted: true }>;
  /**
   * POST /groups/:groupId/promote { byAccountId, accountId } → 200 {}，不推事件。
   * 403 NO_PERMISSION（by 不是群主）/ 409 NOT_MEMBER_YET（对方 member_joined 还没到）。
   */
  promote(
    groupId: string,
    input: { byAccountId: string; accountId: string },
  ): Promise<void>;
  /** GET /groups/:groupId/members → [{ platformUserId }]：网关视角的当前成员。 */
  listMembers(groupId: string): Promise<{ platformUserId: string }[]>;
  /**
   * GET <mediaUrl>（message 事件的 mediaUrl，指向网关的 /media/:id）→ 文件字节（C1）。只接受网关自己的地址：
   * 相对路径按 base url 解析，绝对地址必须与 base url 同源，否则抛 UntrustedMediaUrlError —— 不替事件里的任意
   * URL 发请求。过期 / 不存在 → GatewayResponseError 404。
   */
  downloadMedia(
    mediaUrl: string,
  ): Promise<{ bytes: Buffer; contentType: string | null }>;
  /**
   * POST /groups/:groupId/kick { byAccountId, targetPlatformUserId } → 200 { kicked: true }（agent 的 kick_user，#12）。
   * 目标在 200 返回前已从成员列表移除。同步错误按 GatewayResponseError 抛：409 OWNER_LEFT（群主已退群）/
   * 403 NO_PERMISSION（by 不是群主也没被 promote）/ 409 ACCOUNT_OFFLINE / 504 NETWORK_TIMEOUT（结果未知：
   * 调用方用 listMembers 在 2 秒内收敛判断）。响应本身可能要 1–5 秒（timeoutMs 默认 10s 够）。
   */
  kick(
    groupId: string,
    input: { byAccountId: string; targetPlatformUserId: string },
  ): Promise<{ kicked: true }>;
  /**
   * POST /groups/:groupId/leave { accountId } → 200 {}，随后推 member_left（leave-all job，#16）。
   * 500（没退成，账号仍是成员）与 409 ACCOUNT_OFFLINE 都按 GatewayResponseError 抛，由 job 记 errors；
   * 连不上 / 超时是 GatewayUnreachableError（结果未知：job 先看成员列表再决定要不要重发）。
   */
  leave(groupId: string, input: { accountId: string }): Promise<void>;
};

/** 邀请链接：readyAfterMs 是网关说的「多久后才可用」（可能为 0） */
export type GatewayInvite = { inviteLink: string; readyAfterMs: number };

export type GatewaySendInput = {
  /** 网关侧的 groupId（groups.gatewayGroupId） */
  groupId: string;
  accountId: string;
  /** 幂等键：重试 / 重发都带同一个（网关不按它去重，对账靠它） */
  clientMsgId: string;
  text: string;
};

/** by-client-id 查询命中：网关里最早落地的那一条 */
export type GatewayMessageLanding = { msgId: string; sentAt: string };

/** SSE 一帧解析后的事件：id 帧 → eventId（网关保证全局单调递增的整数）、event 帧 → type、data 帧 → JSON。 */
export type GatewayEvent = {
  eventId: number;
  type: string;
  data: Record<string, unknown>;
};

export type OpenEventStreamOptions = {
  /** 独占：只要 eventId > since 的事件；null = 不带 since */
  since: number | null;
  /** 停机时 abort：流安静结束，不抛错 */
  signal?: AbortSignal;
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
  /**
   * true = 网关已经回了响应头（请求确定送达、可能已被处理），失败的是读响应体 / 响应体不是 JSON。
   * 对有副作用的请求（send）这就是「结果不明」，不能当成没发出去重试。
   */
  readonly responded: boolean;

  constructor(
    method: string,
    path: string,
    cause: unknown,
    opts: { responded?: boolean } = {},
  ) {
    super(`网关 ${method} ${path} 请求失败`, { cause });
    this.name = "GatewayUnreachableError";
    this.responded = opts.responded ?? false;
  }
}

/** mediaUrl 不是网关自己的地址：不下载。 */
export class UntrustedMediaUrlError extends Error {
  constructor(mediaUrl: string) {
    super(`mediaUrl 不是网关的地址，不下载：${mediaUrl}`);
    this.name = "UntrustedMediaUrlError";
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

  /** 一次 JSON 往返：非 2xx → GatewayResponseError；连不上 / 超时 / 2xx 但不是 JSON → GatewayUnreachableError。 */
  async function request(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(payload ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GatewayUnreachableError(method, path, err);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // 响应头已到、读响应体时断了 / 超时了：请求确定送达
      throw new GatewayUnreachableError(method, path, err, { responded: true });
    }
    let body: unknown;
    try {
      body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch (err) {
      if (res.ok) {
        throw new GatewayUnreachableError(method, path, err, {
          responded: true,
        });
      }
      body = text;
    }
    if (!res.ok) throw new GatewayResponseError(method, path, res.status, body);
    return { status: res.status, body };
  }

  async function post(path: string): Promise<unknown> {
    return (await request("POST", path)).body;
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
    openEventStream(opts) {
      return openEventStream(fetchImpl, baseUrl, opts);
    },
    async send(input) {
      await request(
        "POST",
        `/groups/${encodeURIComponent(input.groupId)}/send`,
        {
          accountId: input.accountId,
          clientMsgId: input.clientMsgId,
          text: input.text,
        },
      );
      return { accepted: true };
    },
    async getMessageByClientId(groupId, clientMsgId) {
      const path = `/groups/${encodeURIComponent(groupId)}/messages/by-client-id/${encodeURIComponent(clientMsgId)}`;
      let body: unknown;
      try {
        ({ body } = await request("GET", path));
      } catch (err) {
        // 404 是这个端点的正常答案（没落地），其余错误原样抛给调用方分辨「查询不可用」
        if (err instanceof GatewayResponseError && err.status === 404) {
          return null;
        }
        throw err;
      }
      const { msgId, sentAt } = body as { msgId?: unknown; sentAt?: unknown };
      if (typeof msgId !== "string" || typeof sentAt !== "string") {
        throw new GatewayUnreachableError(
          "GET",
          path,
          new Error("响应缺少 msgId / sentAt"),
        );
      }
      return { msgId, sentAt };
    },
    async createGroup(input) {
      const body = (await request("POST", "/groups", input)).body;
      const groupId = (body as { groupId?: unknown }).groupId;
      if (typeof groupId !== "string" || groupId === "") {
        throw new GatewayUnreachableError(
          "POST",
          "/groups",
          new Error("响应缺少 groupId"),
        );
      }
      return { groupId };
    },
    async createInvite(groupId) {
      const path = `/groups/${encodeURIComponent(groupId)}/invite`;
      const body = (await request("POST", path)).body;
      const { inviteLink, readyAfterMs } = body as {
        inviteLink?: unknown;
        readyAfterMs?: unknown;
      };
      if (typeof inviteLink !== "string" || inviteLink === "") {
        throw new GatewayUnreachableError(
          "POST",
          path,
          new Error("响应缺少 inviteLink"),
        );
      }
      // readyAfterMs 缺了 / 不是数按 0 处理：真不可用时 join 会回 INVITE_NOT_READY，job 按它等
      const ready =
        typeof readyAfterMs === "number" && Number.isFinite(readyAfterMs)
          ? Math.max(0, readyAfterMs)
          : 0;
      return { inviteLink, readyAfterMs: ready };
    },
    async joinGroup(groupId, input) {
      await request(
        "POST",
        `/groups/${encodeURIComponent(groupId)}/join`,
        input,
      );
      return { accepted: true };
    },
    async promote(groupId, input) {
      await request(
        "POST",
        `/groups/${encodeURIComponent(groupId)}/promote`,
        input,
      );
    },
    async listMembers(groupId) {
      const path = `/groups/${encodeURIComponent(groupId)}/members`;
      const body = (await request("GET", path)).body;
      if (!Array.isArray(body)) {
        throw new GatewayUnreachableError(
          "GET",
          path,
          new Error("响应不是成员数组"),
        );
      }
      return body.flatMap((m: unknown) => {
        const platformUserId = (m as { platformUserId?: unknown })
          ?.platformUserId;
        return typeof platformUserId === "string" ? [{ platformUserId }] : [];
      });
    },
    async downloadMedia(mediaUrl) {
      let url: URL;
      try {
        url = new URL(mediaUrl, `${baseUrl}/`);
      } catch {
        throw new UntrustedMediaUrlError(mediaUrl);
      }
      if (url.origin !== new URL(baseUrl).origin) {
        throw new UntrustedMediaUrlError(mediaUrl);
      }
      let res: Response;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new GatewayUnreachableError("GET", url.pathname, err);
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new GatewayResponseError("GET", url.pathname, res.status, body);
      }
      try {
        return {
          bytes: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get("content-type"),
        };
      } catch (err) {
        throw new GatewayUnreachableError("GET", url.pathname, err, {
          responded: true,
        });
      }
    },
    async kick(groupId, input) {
      await request(
        "POST",
        `/groups/${encodeURIComponent(groupId)}/kick`,
        input,
      );
      return { kicked: true };
    },
    async leave(groupId, input) {
      await request(
        "POST",
        `/groups/${encodeURIComponent(groupId)}/leave`,
        input,
      );
    },
  };
}

// ---- SSE 事件流（#8）------------------------------------------------------------------

/**
 * 读 GET /events 的 SSE 流。按 SSE 规范切帧：行以 \n（或 \r\n）分隔，空行派发一帧；`field: value`，
 * 同一帧里多行 data 用 \n 拼接；以 `:` 开头的是注释（心跳），忽略。只认 id / event / data 三个字段。
 * - 网关回非 2xx（503 等）→ GatewayResponseError；连不上 / 不是 text/event-stream → GatewayUnreachableError；
 * - 服务端掐断（body 读到 done）→ GatewayUnreachableError（对 worker 来说就是「重连」的信号）；
 * - signal abort → 生成器 return，不抛。
 * - id 不是整数、data 不是 JSON 对象的帧：跳过（不能因为一帧坏了让整条流断掉），由调用方的日志可见 ——
 *   这里不打日志（客户端不知道 runId）。
 */
async function* openEventStream(
  fetchImpl: typeof fetch,
  baseUrl: string,
  opts: OpenEventStreamOptions,
): AsyncGenerator<GatewayEvent, void, undefined> {
  const path =
    opts.since === null
      ? "/events"
      : `/events?since=${encodeURIComponent(String(opts.since))}`;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return;
    throw new GatewayUnreachableError("GET", path, err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch {
      // 非 JSON 错误体：原文即可
    }
    throw new GatewayResponseError("GET", path, res.status, body);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream") || !res.body) {
    throw new GatewayUnreachableError(
      "GET",
      path,
      new Error(`响应不是 SSE（content-type: ${contentType || "无"}）`),
    );
  }

  // fetch 的 body 在 lib.dom 里是 ReadableStream<any>；这里钉成字节流，decode 才有类型可查
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (opts.signal?.aborted) return;
        throw new GatewayUnreachableError("GET", path, err);
      }
      if (chunk.done) {
        if (opts.signal?.aborted) return;
        throw new GatewayUnreachableError(
          "GET",
          path,
          new Error("事件流已断开"),
        );
      }
      const bytes: Uint8Array = chunk.value;
      buffer += decoder.decode(bytes, { stream: true });
      // 帧以空行结束；\r\n 统一成 \n 再切
      buffer = buffer.replace(/\r\n/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = parseSseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame) yield frame;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // 生成器被提前 return（worker 停机 / 调用方 break）时释放连接
    await reader.cancel().catch(() => undefined);
  }
}

/** 一帧原文 → 事件；缺 id / event / data 或形状不对返回 undefined（调用方跳过）。 */
export function parseSseFrame(raw: string): GatewayEvent | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined || event === undefined || data.length === 0) {
    return undefined;
  }
  const eventId = Number(id);
  if (!Number.isSafeInteger(eventId)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return { eventId, type: event, data: parsed as Record<string, unknown> };
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
    openEventStream: (opts) => resolve().openEventStream(opts),
    send: (input) => resolve().send(input),
    getMessageByClientId: (groupId, clientMsgId) =>
      resolve().getMessageByClientId(groupId, clientMsgId),
    createGroup: (input) => resolve().createGroup(input),
    createInvite: (groupId) => resolve().createInvite(groupId),
    joinGroup: (groupId, input) => resolve().joinGroup(groupId, input),
    promote: (groupId, input) => resolve().promote(groupId, input),
    listMembers: (groupId) => resolve().listMembers(groupId),
    downloadMedia: (mediaUrl) => resolve().downloadMedia(mediaUrl),
    kick: (groupId, input) => resolve().kick(groupId, input),
    leave: (groupId, input) => resolve().leave(groupId, input),
  };
}
