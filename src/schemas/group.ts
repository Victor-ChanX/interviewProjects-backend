// 群（题目 2.3 `POST /api/groups`、`GET /api/groups[/:id]`、`PATCH /api/groups/:id`；issue #11）的 zod schema。
// Read 模型可派生：status / role 用具名 enum（.meta({ id }) 进 openapi components），取值从生成的
// Prisma enum 派生，不抄第二份；可空字段恒下发 null；字段不带 default。
import { z } from "zod";

import {
  GroupStatus as PrismaGroupStatus,
  MemberRole as PrismaMemberRole,
} from "../db/generated/enums.js";

/** 题目 2.3：`active | unreachable | left` */
export const GroupStatus = z
  .enum(Object.values(PrismaGroupStatus))
  .meta({ id: "GroupStatus" });
export type GroupStatus = z.infer<typeof GroupStatus>;

/** 题目 2.3：`creator | admin | member`（建群后创建者是 creator，memberAccountIds[0] 是 admin，其余 member） */
export const MemberRole = z
  .enum(Object.values(PrismaMemberRole))
  .meta({ id: "MemberRole" });
export type MemberRole = z.infer<typeof MemberRole>;

/** 题目 2.3 members[]：`{ accountId, platformUserId, role }`。外部用户（非服务账号）accountId 为 null。 */
export const GroupMemberRead = z
  .object({
    accountId: z.string().nullable(),
    platformUserId: z.string(),
    role: MemberRole,
  })
  .meta({ id: "GroupMemberRead" });
export type GroupMemberRead = z.infer<typeof GroupMemberRead>;

/**
 * 题目 2.3：`{ id, gatewayGroupId, status, creatorAccountId, agentEnabled, autoKickEnabled, members,
 * activeSequenceRunId, activeAgentRunId }`。
 * - gatewayGroupId：建群 job 的 create 步完成前为 null；
 * - activeSequenceRunId / activeAgentRunId：只在有 running 的运行时非空。
 */
export const GroupRead = z
  .object({
    id: z.string(),
    gatewayGroupId: z.string().nullable(),
    status: GroupStatus,
    creatorAccountId: z.string(),
    agentEnabled: z.boolean(),
    autoKickEnabled: z.boolean(),
    members: z.array(GroupMemberRead),
    activeSequenceRunId: z.string().nullable(),
    activeAgentRunId: z.string().nullable(),
  })
  .meta({ id: "GroupRead" });
export type GroupRead = z.infer<typeof GroupRead>;

/**
 * 题目 2.3 把 `GET /api/groups` 与 `GET /api/groups/:id` 写成同一形状（评审按它对接），所以列表是
 * GroupRead 的裸数组，与 GET /api/accounts 同样登记在 scripts/export-openapi.mts 的
 * BARE_ARRAY_RESPONSE_BASELINE（本仓例外，新端点别学）。
 */
export const GroupList = z.array(GroupRead).meta({ id: "GroupList" });
export type GroupList = z.infer<typeof GroupList>;

export const GroupIdParams = z.object({
  id: z.string().min(1),
});

/**
 * 题目 2.3：`{ creatorAccountId, memberAccountIds[] }`；memberAccountIds 至少 1 个、不含群主、不重复 ——
 * 这三条是「请求形状」，由 zod 拦成 400 VALIDATION_ERROR（题目）；「账号必须 online」是业务规则，
 * service 里判成 422 ACCOUNT_NOT_ONLINE。
 */
export const CreateGroupRequest = z
  .object({
    creatorAccountId: z.string().min(1),
    memberAccountIds: z.array(z.string().min(1)).min(1),
  })
  .refine((v) => !v.memberAccountIds.includes(v.creatorAccountId), {
    path: ["memberAccountIds"],
    message: "memberAccountIds 不能包含群主 creatorAccountId",
  })
  .refine(
    (v) => new Set(v.memberAccountIds).size === v.memberAccountIds.length,
    {
      path: ["memberAccountIds"],
      message: "memberAccountIds 不能有重复",
    },
  );
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

/** 202：建群 job 已落库（running），进度在 GET /api/jobs/:jobId */
export const CreateGroupResponse = z
  .object({
    jobId: z.string(),
  })
  .meta({ id: "CreateGroupResponse" });
export type CreateGroupResponse = z.infer<typeof CreateGroupResponse>;

/** 题目 2.3：`{ agentEnabled?, autoKickEnabled? }`，都不传 = 什么都不改 */
export const PatchGroupRequest = z.object({
  agentEnabled: z.boolean().optional(),
  autoKickEnabled: z.boolean().optional(),
});
export type PatchGroupRequest = z.infer<typeof PatchGroupRequest>;

/**
 * 题目 2.3 `POST /api/groups/:id/leave-all` → 202 `{ jobId }`（#16）：leave_all job 已落库（running），
 * 进度在 GET /api/jobs/:jobId（step 形如 `leave:<accountId>`）。
 */
export const LeaveAllResponse = z
  .object({
    jobId: z.string(),
  })
  .meta({ id: "LeaveAllResponse" });
export type LeaveAllResponse = z.infer<typeof LeaveAllResponse>;

/** 删除群（#62）：删了多少条消息 / agent run / 序列运行（给控制台的提示用） */
export const DeleteGroupResponse = z
  .object({
    id: z.string(),
    messagesDeleted: z.number().int(),
    agentRunsDeleted: z.number().int(),
    sequenceRunsDeleted: z.number().int(),
  })
  .meta({ id: "DeleteGroupResponse" });
export type DeleteGroupResponse = z.infer<typeof DeleteGroupResponse>;
