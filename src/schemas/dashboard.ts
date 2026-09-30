// 工作台概览（#22：GET /api/dashboard/summary）的 zod schema。控制台首页一眼看出平台在干什么、哪里需要处理。
// 全是计数（整数），字段恒下发、不带 default；「今日」按业务时区自然日（src/core/business-day.ts），
// 本次统计用的起点与时区随响应下发（dayStart / timeZone），前端展示「今日（自 … 起）」不用自己算。
import { z } from "zod";

/** 账号六态各自的数量 + 合计（题目 A1） */
export const DashboardAccounts = z
  .object({
    idle: z.number().int(),
    online: z.number().int(),
    rate_limited: z.number().int(),
    disconnected: z.number().int(),
    suspended: z.number().int(),
    session_expired: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: "DashboardAccounts" });

/** 群三态各自的数量 + 合计；agentEnabled = 开着 Agent 的群数（不分状态） */
export const DashboardGroups = z
  .object({
    active: z.number().int(),
    unreachable: z.number().int(),
    left: z.number().int(),
    total: z.number().int(),
    agentEnabled: z.number().int(),
  })
  .meta({ id: "DashboardGroups" });

/**
 * 消息：todayInbound / todayOutbound = 时间线排序键 sentAt 落在今日的入站行（非 outbox 行）/ 出站行（outbox 行，
 * 任意投递状态）；outboundFailed / outboundUnknown / outboundQueued = 当前处于该投递状态的出站行数（不限日期）。
 */
export const DashboardMessages = z
  .object({
    todayInbound: z.number().int(),
    todayOutbound: z.number().int(),
    outboundFailed: z.number().int(),
    outboundUnknown: z.number().int(),
    outboundQueued: z.number().int(),
  })
  .meta({ id: "DashboardMessages" });

/** Agent 运行：running 当前数；todayFinished / todayFailed 按 finishedAt 落在今日；blocked = 全部 blocked 的运行数 */
export const DashboardAgentRuns = z
  .object({
    running: z.number().int(),
    todayFinished: z.number().int(),
    todayFailed: z.number().int(),
    blocked: z.number().int(),
  })
  .meta({ id: "DashboardAgentRuns" });

export const DashboardSequenceRuns = z
  .object({
    running: z.number().int(),
  })
  .meta({ id: "DashboardSequenceRuns" });

/** 建群 / leave-all job：running 当前数；todayFailed 按 finishedAt 落在今日 */
export const DashboardJobs = z
  .object({
    running: z.number().int(),
    todayFailed: z.number().int(),
  })
  .meta({ id: "DashboardJobs" });

/** 异常中心：未处理（resolvedAt 为 null）的不一致记录数 */
export const DashboardInconsistencies = z
  .object({
    unresolved: z.number().int(),
  })
  .meta({ id: "DashboardInconsistencies" });

/** 各组计数在同一个只读事务（同一快照）里取，口径一致 */
export const DashboardSummary = z
  .object({
    accounts: DashboardAccounts,
    groups: DashboardGroups,
    messages: DashboardMessages,
    agentRuns: DashboardAgentRuns,
    sequenceRuns: DashboardSequenceRuns,
    jobs: DashboardJobs,
    inconsistencies: DashboardInconsistencies,
    /** 「今日」的起点：业务时区当天 00:00 对应的 UTC 时刻 */
    dayStart: z.iso.datetime(),
    /** 业务时区（IANA 名，如 Asia/Shanghai） */
    timeZone: z.string(),
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: "DashboardSummary" });
export type DashboardSummary = z.infer<typeof DashboardSummary>;
