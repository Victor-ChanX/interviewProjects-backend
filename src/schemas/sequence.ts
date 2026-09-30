// 定时序列（题目 B1 + 2.3 `POST /api/sequences`、`POST /api/groups/:id/sequence-runs`、`GET /api/sequence-runs/:id`；
// issue #15）的 zod schema。
// Read 模型可派生：status / accountRole 都是具名 enum（.meta({ id }) 进 openapi components），取值从生成的
// Prisma enum 派生；时间字段 ISO 8601 UTC 字符串；可空字段恒下发 null；字段不带 default。
// 序列定义的「形状」规则（index 从 1 连续、delaySeconds ≥ 0、key 非空）在这里拦成 400 VALIDATION_ERROR；
// 「占位符解析不到」是业务规则，service 里判成 422 UNRESOLVED_PLACEHOLDER。
import { z } from "zod";

import {
  SequenceAccountRole as PrismaSequenceAccountRole,
  SequenceRunStatus as PrismaSequenceRunStatus,
  SequenceStepStatus as PrismaSequenceStepStatus,
} from "../db/generated/enums.js";

/** `admin | member`：admin = 群里 role ∈ {creator, admin} 的账号发（优先 admin）；member = role = member */
export const SequenceAccountRole = z
  .enum(Object.values(PrismaSequenceAccountRole))
  .meta({ id: "SequenceAccountRole" });
export type SequenceAccountRole = z.infer<typeof SequenceAccountRole>;

/** `running | finished | failed | stopped`（stopped = 群变 unreachable） */
export const SequenceRunStatus = z
  .enum(Object.values(PrismaSequenceRunStatus))
  .meta({ id: "SequenceRunStatus" });
export type SequenceRunStatus = z.infer<typeof SequenceRunStatus>;

/** `pending | accepted | sent | skipped | failed` */
export const SequenceStepStatus = z
  .enum(Object.values(PrismaSequenceStepStatus))
  .meta({ id: "SequenceStepStatus" });
export type SequenceStepStatus = z.infer<typeof SequenceStepStatus>;

// ---- 序列定义（题目 B1 的 JSON）--------------------------------------------------------

export const SequenceStepDefinition = z
  .object({
    index: z.number().int().min(1),
    accountRole: SequenceAccountRole,
    /** 含 `{key}` 占位符的原文；key 匹配 [A-Za-z0-9_]+ */
    text: z.string().min(1),
    delaySeconds: z.number().int().min(0),
  })
  .meta({ id: "SequenceStepDefinition" });
export type SequenceStepDefinition = z.infer<typeof SequenceStepDefinition>;

/**
 * 题目 B1：`{ name, steps: [{ index, accountRole, text, delaySeconds }] }`。
 * steps 至少一步，index 必须是 1, 2, 3 … 连续且按序（重启重排、stepVars 都按 index 找步，乱序 / 跳号会让
 * 「第 k 步」失去意义）。
 */
export const SequenceDefinition = z
  .object({
    name: z.string().min(1),
    steps: z.array(SequenceStepDefinition).min(1),
  })
  .superRefine((def, ctx) => {
    def.steps.forEach((step, i) => {
      if (step.index !== i + 1) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "index"],
          message: `steps[${i}].index 应为 ${i + 1}（index 从 1 起连续递增）`,
        });
      }
    });
  })
  .meta({ id: "SequenceDefinition" });
export type SequenceDefinition = z.infer<typeof SequenceDefinition>;

export const SequenceCreated = z
  .object({ id: z.string() })
  .meta({ id: "SequenceCreated" });
export type SequenceCreated = z.infer<typeof SequenceCreated>;

/** 序列列表项（控制台页面 5「选序列」用） */
export const SequenceRead = z
  .object({
    id: z.string(),
    name: z.string(),
    steps: z.array(SequenceStepDefinition),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "SequenceRead" });
export type SequenceRead = z.infer<typeof SequenceRead>;

/** 短列表形状 `{ items, total }`：序列天然不多，不分页 */
export const SequenceList = z
  .object({
    items: z.array(SequenceRead),
    total: z.number().int(),
  })
  .meta({ id: "SequenceList" });
export type SequenceList = z.infer<typeof SequenceList>;

// ---- 启动运行 -----------------------------------------------------------------------

/** key → value。value 允许空串：vars 里的 "" 视为未提供，stepVars 里的 "" 表示这一步不改（B1） */
export const VarMap = z.record(z.string().min(1), z.string());
export type VarMap = z.infer<typeof VarMap>;

/** varSources：每个 key 来自 `default`（即 vars）还是 `step:<index>`（最初给出它的那一步） */
export const VarSourceMap = z.record(z.string().min(1), z.string());
export type VarSourceMap = z.infer<typeof VarSourceMap>;

/**
 * 题目 2.3：`{ sequenceId, vars, stepVars }`。stepVars 按步：`{ "2": { location: "…" } }`，键是步骤 index 的十进制字符串；
 * 指向不存在的步的键被忽略（不影响任何一步的取值）。vars / stepVars 可省略（等于空）。
 */
export const StartSequenceRunRequest = z.object({
  sequenceId: z.string().min(1),
  vars: VarMap.default({}),
  stepVars: z.record(z.string().regex(/^[1-9]\d*$/), VarMap).default({}),
});
export type StartSequenceRunRequest = z.infer<typeof StartSequenceRunRequest>;

export const SequenceRunStarted = z
  .object({ runId: z.string() })
  .meta({ id: "SequenceRunStarted" });
export type SequenceRunStarted = z.infer<typeof SequenceRunStarted>;

// ---- 运行读模型 ---------------------------------------------------------------------

/**
 * 题目 2.3：`steps: [{ index, status, scheduledAt, sentAt, clientMsgId, resolvedVars, varSources }]`，
 * 另带定义快照（accountRole / delaySeconds）、实际发送账号、skippedAt / failCode 供页面显示原因。
 * resolvedVars 只含该步文本里出现的 key；varSources 与它同键。
 */
export const SequenceRunStepRead = z
  .object({
    index: z.number().int(),
    status: SequenceStepStatus,
    accountRole: SequenceAccountRole,
    delaySeconds: z.number().int(),
    scheduledAt: z.iso.datetime().nullable(),
    sentAt: z.iso.datetime().nullable(),
    skippedAt: z.iso.datetime().nullable(),
    accountId: z.string().nullable(),
    clientMsgId: z.string().nullable(),
    failCode: z.string().nullable(),
    resolvedVars: VarMap,
    varSources: VarSourceMap,
  })
  .meta({ id: "SequenceRunStepRead" });
export type SequenceRunStepRead = z.infer<typeof SequenceRunStepRead>;

/** 题目 2.3：`{ status, currentStepIndex, steps }`，另带 id / sequenceId / groupId / 时间 */
export const SequenceRunRead = z
  .object({
    id: z.string(),
    sequenceId: z.string(),
    groupId: z.string(),
    status: SequenceRunStatus,
    /** 当前待发的步骤 index（run 结束后停在最后一步） */
    currentStepIndex: z.number().int(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    steps: z.array(SequenceRunStepRead),
  })
  .meta({ id: "SequenceRunRead" });
export type SequenceRunRead = z.infer<typeof SequenceRunRead>;

export const SequenceRunIdParams = z.object({ id: z.string().min(1) });
