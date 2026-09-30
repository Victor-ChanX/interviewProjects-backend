// Agent run（题目 2.3 `GET /api/agent-runs/:id` / `GET /api/groups/:id/agent-runs`；issue #13）的 zod schema。
// Read 模型可派生：status / endReason / kind / auditVerdict 都是具名 enum（.meta({ id }) 进 openapi components），
// 取值从生成的 Prisma enum 派生；时间字段 ISO 8601 UTC 字符串；可空字段恒下发 null；字段不带 default。
import { z } from "zod";

import {
  AgentRunEndReason as PrismaAgentRunEndReason,
  AgentRunStatus as PrismaAgentRunStatus,
  AgentStepKind as PrismaAgentStepKind,
  AuditVerdict as PrismaAuditVerdict,
} from "../db/generated/enums.js";

/** `running | finished | failed | blocked | cancelled` */
export const AgentRunStatus = z
  .enum(Object.values(PrismaAgentRunStatus))
  .meta({ id: "AgentRunStatus" });
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/** 仅 status ≠ running 时有值：final → finished；budget_exhausted | wall_clock | protocol_errors → failed；audit_blocked → blocked；cancelled → cancelled */
export const AgentRunEndReason = z
  .enum(Object.values(PrismaAgentRunEndReason))
  .meta({ id: "AgentRunEndReason" });
export type AgentRunEndReason = z.infer<typeof AgentRunEndReason>;

/** `tool_use | final | protocol_error`（协议错误步的 toolUseId / name / input 为 null） */
export const AgentStepKind = z
  .enum(Object.values(PrismaAgentStepKind))
  .meta({ id: "AgentStepKind" });
export type AgentStepKind = z.infer<typeof AgentStepKind>;

/** send_message / kick_user 的审计结论；未审计或拿不到结论为 null */
export const AuditVerdict = z
  .enum(Object.values(PrismaAuditVerdict))
  .meta({ id: "AuditVerdict" });
export type AuditVerdict = z.infer<typeof AuditVerdict>;

/** 触发消息快照（题目 2.2 触发上下文的 triggerMessages 元素） */
export const TriggerMessage = z
  .object({
    msgId: z.string(),
    senderPlatformUserId: z.string(),
    text: z.string(),
    sentAt: z.string(),
  })
  .meta({ id: "AgentTriggerMessage" });

/**
 * 题目 2.3：`steps: [{ kind, toolUseId, name, input, resultSummary, isError, errorCode, auditVerdict, rawResponse }]`。
 * rawResponse 是 Agent 服务原始响应体（截到 2KB）；isError = true 时 errorCode 必填（CHECK 约束）；resultSummary ≤ 200 字。
 */
export const AgentStepRead = z
  .object({
    index: z.number().int(),
    kind: AgentStepKind,
    toolUseId: z.string().nullable(),
    name: z.string().nullable(),
    input: z.record(z.string(), z.unknown()).nullable(),
    resultSummary: z.string().nullable(),
    isError: z.boolean(),
    errorCode: z.string().nullable(),
    auditVerdict: AuditVerdict.nullable(),
    auditAttempts: z.number().int(),
    rawResponse: z.string().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "AgentStepRead" });
export type AgentStepRead = z.infer<typeof AgentStepRead>;

/** 题目 2.3：`{ id, groupId, status, endReason, summary, … }`（列表项，不含 steps） */
export const AgentRunRead = z
  .object({
    id: z.string(),
    groupId: z.string(),
    status: AgentRunStatus,
    endReason: AgentRunEndReason.nullable(),
    summary: z.string().nullable(),
    stepCount: z.number().int(),
    maxSteps: z.number().int(),
    budgetMs: z.number().int(),
    accumulatedMs: z.number().int(),
    triggerMessages: z.array(TriggerMessage),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "AgentRunRead" });
export type AgentRunRead = z.infer<typeof AgentRunRead>;

/** 详情 = 列表项 + steps（按 index 升序，含协议错误步） */
export const AgentRunDetail = AgentRunRead.extend({
  steps: z.array(AgentStepRead),
}).meta({ id: "AgentRunDetail" });
export type AgentRunDetail = z.infer<typeof AgentRunDetail>;

export const AgentRunIdParams = z.object({ id: z.string().min(1) });

/** 短列表形状 `{ items, total }`：items 是最近 20 条（最新在前），total 是该群全部 run 数 */
export const AgentRunListResponse = z
  .object({
    items: z.array(AgentRunRead),
    total: z.number().int(),
  })
  .meta({ id: "AgentRunListResponse" });
export type AgentRunListResponse = z.infer<typeof AgentRunListResponse>;
