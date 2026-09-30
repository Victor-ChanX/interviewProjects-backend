// access token：HS256 JWT，node:crypto 的 HMAC，不加依赖（签 / 验各十几行，jose 之类的包在这里
// 只多带一个 owner 决定）。密钥来自 src/core/config.ts 的 JWT_SECRET。
//
// claims：sub（用户 id）、username、role、jti（随机 token id）、sid（sessions 行 id —— issue #17：
// 闸门验签后按它查该行是否 revokedAt，logout / refresh 复用作废后 access token 立即失效）、
// iat、exp（签发后 15 分钟）。verify 只认 HS256、只认没过期的；任何格式 / 签名 / 过期问题都返回
// 失败原因而不是抛错，由闸门（src/api/guards.ts）统一转成 401 UNAUTHORIZED。
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Clock } from "./clock.js";
import { config } from "./config.js";

/** 用户角色：与 prisma/schema.prisma 的 enum UserRole 同一份取值（core 不 import 生成物，故手写）。 */
export type Role = "admin" | "viewer";

/** 闸门解析出来挂在 request 上、再作为普通参数传进 service 的身份。 */
export type Principal = {
  userId: string;
  username: string;
  role: Role;
  /**
   * 凭证所属的会话（sessions 表行 id，issue #17）。access token 里是 sid claim；
   * requireUser 按它查会话是否已作废，logout 按它找到整个会话族。
   */
  sessionId: string;
};

export type AccessTokenClaims = Principal & {
  /** token 唯一 id（uuid） */
  jti: string;
  /** 签发时刻，unix 秒 */
  iat: number;
  /** 过期时刻，unix 秒 */
  exp: number;
};

/** 题目 2.3：access token 有效期 15 分钟 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export type VerifyFailure = "malformed" | "bad_signature" | "expired";
export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: VerifyFailure };

const HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");

/** 缺 JWT_SECRET 时只在这里抛：buildApp 启动时先查一次，运行期不会走到。 */
function secret(): string {
  if (!config.jwtSecret) {
    throw new Error("缺少 JWT_SECRET（src/core/config.ts）");
  }
  return config.jwtSecret;
}

export function assertJwtSecretConfigured(): void {
  secret();
}

function hmac(signingInput: string): Buffer {
  return createHmac("sha256", secret()).update(signingInput).digest();
}

export function signAccessToken(
  principal: Principal,
  opts: { clock?: Clock; ttlSeconds?: number } = {},
): string {
  const now = opts.clock?.now() ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessTokenClaims = {
    userId: principal.userId,
    username: principal.username,
    role: principal.role,
    sessionId: principal.sessionId,
    jti: randomUUID(),
    iat,
    exp: iat + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS),
  };
  // 线上的 sub 用标准名；userId 只是本项目里的别名，编码时映射一次
  const payload = Buffer.from(
    JSON.stringify({
      sub: claims.userId,
      username: claims.username,
      role: claims.role,
      sid: claims.sessionId,
      jti: claims.jti,
      iat: claims.iat,
      exp: claims.exp,
    }),
  ).toString("base64url");
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${hmac(signingInput).toString("base64url")}`;
}

function isRole(v: unknown): v is Role {
  return v === "admin" || v === "viewer";
}

function decodePayload(raw: string): AccessTokenClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.sub !== "string" ||
    typeof p.username !== "string" ||
    !isRole(p.role) ||
    typeof p.sid !== "string" ||
    typeof p.jti !== "string" ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number"
  ) {
    return null;
  }
  return {
    userId: p.sub,
    username: p.username,
    role: p.role,
    sessionId: p.sid,
    jti: p.jti,
    iat: p.iat,
    exp: p.exp,
  };
}

export function verifyAccessToken(
  token: string,
  opts: { clock?: Clock } = {},
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];
  // 头固定：不接受 alg=none 或换算法（HS256 之外一律拒）
  if (header !== HEADER) return { ok: false, reason: "malformed" };

  const expected = hmac(`${header}.${payload}`);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const claims = decodePayload(payload);
  if (!claims) return { ok: false, reason: "malformed" };

  const nowSeconds = Math.floor(
    (opts.clock?.now() ?? new Date()).getTime() / 1000,
  );
  if (claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
