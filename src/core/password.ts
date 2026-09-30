// 口令哈希：node:crypto 的 scrypt（不加依赖）。种子（src/db/seed.ts）与登录校验共用。
// 存储格式：`scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`，参数随串保存，日后调参不影响旧记录。
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

async function derive(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  // 不用 util.promisify：它的类型只认三参重载，丢掉 options。
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        // Node 默认 maxmem 32MB；N=16384,r=8 需要 128*N*r ≈ 16MB，留余量
        maxmem: 64 * 1024 * 1024,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * 用户名不存在时拿它跑一遍 verifyPassword：两条失败路径耗时一样，不能从响应快慢判断用户名是否存在。
 * 随机口令的哈希，口令本身已丢弃，任何输入都验不过。
 */
export const UNUSABLE_PASSWORD_HASH =
  "scrypt$16384$8$1$BkklPxSlsK3f3hHe8GWLGA==$rBq7omwaIFXiWcAJAqdqfHQ6+viP1PNAMzO7+oWsOwjgjuiHXQTlOP0EVYddxtzh26pHRf2WXtWV5pF6lc4cSQ==";

/** 格式不认识 / 被截断的串一律 false，不抛错（登录路径上把坏数据当成密码错误处理）。 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}
