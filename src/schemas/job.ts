// 异步任务（题目 2.3 `GET /api/jobs/:jobId`；issue #11 建群、#16 leave-all 复用）的 zod schema。
// Read 模型可派生：status / kind / stepKind 用具名 enum（取值从生成的 Prisma enum 派生）；
// 题目里的 `step ∈ create | invite | join:<accountId> | promote | leave:<accountId>` 是拼出来的字符串，
// 库里拆成 (stepKind, accountId)，这里两样都下发：step 给评审 / 人看，stepKind + accountId 给程序分支。
import { z } from "zod";

import {
  JobKind as PrismaJobKind,
  JobStatus as PrismaJobStatus,
  JobStepKind as PrismaJobStepKind,
} from "../db/generated/enums.js";

/** 题目 2.3：`running | finished | failed`（errors 非空即 failed） */
export const JobStatus = z
  .enum(Object.values(PrismaJobStatus))
  .meta({ id: "JobStatus" });
export type JobStatus = z.infer<typeof JobStatus>;

/** `create_group | leave_all` */
export const JobKind = z
  .enum(Object.values(PrismaJobKind))
  .meta({ id: "JobKind" });
export type JobKind = z.infer<typeof JobKind>;

/** 步骤种类：`create | invite | join | promote | leave`；带账号的步骤（join / leave）另有 accountId */
export const JobStepKind = z
  .enum(Object.values(PrismaJobStepKind))
  .meta({ id: "JobStepKind" });
export type JobStepKind = z.infer<typeof JobStepKind>;

/** 题目 2.3 errors[]：`{ step, code }`，step 形如 `join:acc-2`；stepKind / accountId 是它的拆分 */
export const JobErrorRead = z
  .object({
    step: z.string(),
    stepKind: JobStepKind,
    accountId: z.string().nullable(),
    code: z.string(),
    message: z.string().nullable(),
  })
  .meta({ id: "JobErrorRead" });
export type JobErrorRead = z.infer<typeof JobErrorRead>;

/**
 * 题目 2.3：`{ status, errors: [{ step, code }] }`；多下发 id / kind / groupId / step（当前执行到的步骤，
 * 终态后为最后一步）/ finishedAt 给前端看进度，题目允许多字段。
 */
export const JobRead = z
  .object({
    id: z.string(),
    kind: JobKind,
    status: JobStatus,
    groupId: z.string().nullable(),
    step: z.string().nullable(),
    errors: z.array(JobErrorRead),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "JobRead" });
export type JobRead = z.infer<typeof JobRead>;

export const JobIdParams = z.object({
  jobId: z.string().min(1),
});
