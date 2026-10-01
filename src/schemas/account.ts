// 账号（题目 2.3 accounts 三个端点、A1）的 zod 请求 / 响应 schema。
// Read 模型可派生：状态用具名 enum（.meta({ id }) 进 openapi components），取值从生成的
// Prisma enum 派生，不抄第二份；时间字段 ISO 8601 UTC 字符串，无值为 null；字段不带 default。
import { z } from "zod";

import { AccountStatus as PrismaAccountStatus } from "../db/generated/enums.js";

export const AccountStatus = z
  .enum(Object.values(PrismaAccountStatus))
  .meta({ id: "AccountStatus" });
export type AccountStatus = z.infer<typeof AccountStatus>;

/** 题目 2.3：`{ id, status, platformUserId, rateLimitedUntil }` */
export const AccountRead = z
  .object({
    id: z.string(),
    status: AccountStatus,
    platformUserId: z.string().nullable(),
    rateLimitedUntil: z.iso.datetime().nullable(),
  })
  .meta({ id: "AccountRead" });
export type AccountRead = z.infer<typeof AccountRead>;

/**
 * 题目 2.3 约定 `GET /api/accounts → [{ id, status, platformUserId, rateLimitedUntil }]` 是裸数组，
 * 评审按它对接；这是本仓唯一一个不用 { items, total } 的列表端点，登记在
 * scripts/export-openapi.mts 的 BARE_ARRAY_RESPONSE_BASELINE。
 */
export const AccountList = z.array(AccountRead).meta({ id: "AccountList" });
export type AccountList = z.infer<typeof AccountList>;

/** 新增账号（#63，题目之外的控制台补充）：id 只允许小写字母、数字、- 与 _ */
export const AccountCreateRequest = z.object({
  id: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      "账号 ID 只能用小写字母、数字、- 和 _，以字母或数字开头，最长 32 个字符",
    ),
});
export type AccountCreateRequest = z.infer<typeof AccountCreateRequest>;

export const AccountIdParams = z.object({
  id: z.string().min(1),
});

/** 题目 2.3：`{ to, expectedFrom }`，两者必填；形状错由 setErrorHandler 出 400 VALIDATION_ERROR */
export const AccountTransitionRequest = z.object({
  to: AccountStatus,
  expectedFrom: AccountStatus,
});
export type AccountTransitionRequest = z.infer<typeof AccountTransitionRequest>;

/**
 * 转移结果：题目要求的 `{ status }` 之外带上 from 与级联计数（api.side-effect-count：
 * 进终态顺带改了别的行，前端提示按计数分叉，不能笼统地说「已更新」）。
 * changed = false 表示重复进入同一终态被静默忽略（状态没动、没有级联、没有事件）。
 */
export const AccountTransitionResponse = AccountRead.extend({
  from: AccountStatus,
  changed: z.boolean(),
  membersRemovedCount: z.number().int(),
  messagesCancelledCount: z.number().int(),
  stepsSkippedCount: z.number().int(),
}).meta({ id: "AccountTransitionResponse" });
export type AccountTransitionResponse = z.infer<
  typeof AccountTransitionResponse
>;
