// 上游客户端（OpenAI Chat Completions 兼容格式），用全局 fetch（tests/setup.ts 的 MockAgent 只接管它，测试里打不出外网）：
// - chat：POST {baseUrl}/chat/completions，`Authorization: Bearer <apiKey>`
// - listModels：GET {baseUrl}/models（控制台「获取模型列表」）
// baseUrl / apiKey 每次调用传入（target）：它们来自控制台保存的配置（config-store.ts），控制台改了不用重启。所有进响应 / 日志的原因文本都先把 key 换成 ***（上游报错可能回显 key）。
//
// 超时与重试（关键约束：必须比后端的每轮超时短）：
// - 每次 chat() 有一个**总**时长预算 timeoutMs（turn 用 LLM_TIMEOUT_MS，默认 10s；audit 用 app.ts 的 AUDIT_TIMEOUT_MS，4s），
//   从进入 chat() 起算，含所有重试与退避。每次尝试的 fetch 用「剩余预算」做 AbortSignal 超时。
// - 后端调 /agent/turn 的每轮超时是 AGENT_TURN_TIMEOUT_MS（默认 12s，题目 A5 允许 10–15s）；到点后端就记 TURN_TIMEOUT，
//   之后才到的响应被丢弃。所以 LLM_TIMEOUT_MS 要比它小 1–2 秒：本服务在后端放弃之前自己先收手、回 502，
//   后端记一次 BAD_JSON（同样是协议错误，但不会有「后端已放弃、本服务还在花 token 重试」）。审计同理对 AGENT_AUDIT_TIMEOUT_MS（默认 5s）。
// - 只重试 408 / 429 / 5xx / 连接失败，最多 maxRetries 次（main 用 MAX_RETRIES）；退避 retryBaseMs × 2^(n-1)，有 Retry-After（秒）时取两者较大者；
//   等完之后剩余预算不够 MIN_ATTEMPT_MS 就不再试。400 / 401 / 403 / 404 这类重试也不会变好，直接失败。
//   listModels 是人在控制台点的一次性操作，不重试。
import { systemClock, type Clock } from "../core/clock.js";
import { normalizeBaseUrl, redact } from "./config-store.js";

export type UpstreamTarget = { baseUrl: string; apiKey: string };

export type ChatFailure = {
  ok: false;
  /** 一句话原因（进 502 的 message 与日志；已去掉 key） */
  reason: string;
  /** 最后一次尝试的 HTTP 状态；超时 / 连不上为 null */
  status: number | null;
  attempts: number;
  elapsedMs: number;
};

export type ChatOutcome =
  | { ok: true; completion: unknown; attempts: number; elapsedMs: number }
  | ChatFailure;

export type UpstreamModel = { id: string; ownedBy: string | null };

export type ModelsOutcome =
  | { ok: true; models: UpstreamModel[] }
  | { ok: false; status: number | null; reason: string };

export type ChatClient = {
  /** body 是完整的 chat completion 请求体（model / messages / tools / 服务商参数 …），原样发出 */
  chat(
    target: UpstreamTarget,
    body: Record<string, unknown>,
    opts: { timeoutMs: number },
  ): Promise<ChatOutcome>;
  listModels(
    target: UpstreamTarget,
    opts: { timeoutMs: number },
  ): Promise<ModelsOutcome>;
};

export type OpenAiClientOptions = {
  maxRetries: number;
  /** 首次退避毫秒数，默认 500；测试传小值 */
  retryBaseMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
};

/** 剩余预算少于这个值就不再发起新的尝试（发了也来不及回） */
const MIN_ATTEMPT_MS = 300;
/** 单次退避上限 */
const MAX_BACKOFF_MS = 4_000;

const RETRYABLE = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function errorDetail(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** Retry-After 头（秒数形式）→ 毫秒；HTTP 日期形式或缺失返回 0 */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** 上游错误体里的一句话（OpenAI 形状 { error: { message } }），截短，避免把整页 HTML 塞进日志 */
function upstreamMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string")
      return body.error.message.slice(0, 200);
  } catch {
    // 不是 JSON，取原文开头
  }
  return raw.slice(0, 200);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createOpenAiClient(opts: OpenAiClientOptions): ChatClient {
  const fetchImpl = opts.fetch ?? fetch;
  const clock = opts.clock ?? systemClock;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const headers = (apiKey: string): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  });

  return {
    async chat(target, body, { timeoutMs }) {
      const url = `${normalizeBaseUrl(target.baseUrl)}/chat/completions`;
      const payload = JSON.stringify(body);
      const startedAt = clock.now().getTime();
      const deadline = startedAt + timeoutMs;
      const elapsed = (): number => clock.now().getTime() - startedAt;
      const clean = (text: string): string => redact(text, target.apiKey);
      let attempts = 0;
      let last: { reason: string; status: number | null };

      for (;;) {
        attempts += 1;
        const remaining = deadline - clock.now().getTime();
        let waitMs = retryBaseMs * 2 ** (attempts - 1);
        try {
          const res = await fetchImpl(url, {
            method: "POST",
            headers: headers(target.apiKey),
            body: payload,
            signal: AbortSignal.timeout(Math.max(1, remaining)),
          });
          const raw = await res.text();
          if (res.ok) {
            try {
              return {
                ok: true,
                completion: JSON.parse(raw) as unknown,
                attempts,
                elapsedMs: elapsed(),
              };
            } catch {
              return {
                ok: false,
                reason: "上游响应不是合法 JSON",
                status: res.status,
                attempts,
                elapsedMs: elapsed(),
              };
            }
          }
          last = {
            reason: clean(
              `上游返回 HTTP ${res.status}：${upstreamMessage(raw)}`,
            ),
            status: res.status,
          };
          if (!RETRYABLE(res.status)) break;
          waitMs = Math.max(waitMs, retryAfterMs(res));
        } catch (err) {
          if (isAbortLike(err)) {
            // 预算用完：不再重试（再试也只剩负数的时间）
            last = { reason: `上游在 ${timeoutMs}ms 内没有返回`, status: null };
            break;
          }
          last = {
            reason: clean(`上游连接失败：${errorDetail(err)}`),
            status: null,
          };
        }
        if (attempts > opts.maxRetries) break;
        waitMs = Math.min(waitMs, MAX_BACKOFF_MS);
        if (deadline - clock.now().getTime() - waitMs < MIN_ATTEMPT_MS) break;
        await sleep(waitMs);
      }
      return { ok: false, ...last, attempts, elapsedMs: elapsed() };
    },

    async listModels(target, { timeoutMs }) {
      const url = `${normalizeBaseUrl(target.baseUrl)}/models`;
      const clean = (text: string): string => redact(text, target.apiKey);
      let res: Response;
      let raw: string;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${target.apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        raw = await res.text();
      } catch (err) {
        return {
          ok: false,
          status: null,
          reason: isAbortLike(err)
            ? `上游在 ${timeoutMs}ms 内没有返回`
            : clean(`上游连接失败：${errorDetail(err)}`),
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          reason: clean(`上游返回 HTTP ${res.status}：${upstreamMessage(raw)}`),
        };
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          status: res.status,
          reason: "上游响应不是合法 JSON",
        };
      }
      if (!isRecord(body) || !Array.isArray(body.data)) {
        return {
          ok: false,
          status: res.status,
          reason: "上游响应不是模型列表形状（缺少 data 数组）",
        };
      }
      const models = body.data
        .filter(
          (m): m is Record<string, unknown> =>
            isRecord(m) && typeof m.id === "string" && m.id !== "",
        )
        .map((m) => ({
          id: m.id as string,
          ownedBy: typeof m.owned_by === "string" ? m.owned_by : null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { ok: true, models };
    },
  };
}
