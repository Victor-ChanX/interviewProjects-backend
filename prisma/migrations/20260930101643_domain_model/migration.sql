-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('idle', 'online', 'rate_limited', 'disconnected', 'suspended', 'session_expired');

-- CreateEnum
CREATE TYPE "group_status" AS ENUM ('active', 'unreachable', 'left');

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('creator', 'admin', 'member');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('queued', 'accepted', 'sent', 'failed', 'unknown', 'cancelled');

-- CreateEnum
CREATE TYPE "job_kind" AS ENUM ('create_group', 'leave_all');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('running', 'finished', 'failed');

-- CreateEnum
CREATE TYPE "job_step_kind" AS ENUM ('create', 'invite', 'join', 'promote', 'leave');

-- CreateEnum
CREATE TYPE "agent_run_status" AS ENUM ('running', 'finished', 'failed', 'blocked', 'cancelled');

-- CreateEnum
CREATE TYPE "agent_run_end_reason" AS ENUM ('final', 'budget_exhausted', 'wall_clock', 'protocol_errors', 'audit_blocked', 'cancelled');

-- CreateEnum
CREATE TYPE "agent_step_kind" AS ENUM ('tool_use', 'final', 'protocol_error');

-- CreateEnum
CREATE TYPE "audit_verdict" AS ENUM ('pass', 'fail');

-- CreateEnum
CREATE TYPE "sequence_run_status" AS ENUM ('running', 'finished', 'failed', 'stopped');

-- CreateEnum
CREATE TYPE "sequence_step_status" AS ENUM ('pending', 'accepted', 'sent', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "sequence_account_role" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'viewer');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "status" "account_status" NOT NULL DEFAULT 'idle',
    "platform_user_id" TEXT,
    "rate_limited_until" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "gateway_group_id" TEXT,
    "status" "group_status" NOT NULL DEFAULT 'active',
    "creator_account_id" TEXT NOT NULL,
    "agent_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_kick_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" TEXT NOT NULL,
    "platform_user_id" TEXT NOT NULL,
    "account_id" TEXT,
    "role" "member_role" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","platform_user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "msg_id" TEXT,
    "client_msg_id" TEXT,
    "account_id" TEXT,
    "sender_platform_user_id" TEXT NOT NULL,
    "is_own" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "media_url" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "delivery_status" "delivery_status",
    "fail_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "claimed_by" TEXT,
    "locked_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "accepted_at" TIMESTAMPTZ,
    "unknown_since" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_attempts" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "is_resend" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "http_status" INTEGER,
    "error_code" TEXT,
    "detail" JSONB,

    CONSTRAINT "outbound_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "group_id" TEXT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_cursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_event_id" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "event_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "kind" "job_kind" NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'running',
    "group_id" TEXT,
    "step" "job_step_kind",
    "input" JSONB NOT NULL,
    "state" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ,
    "claimed_by" TEXT,
    "locked_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_errors" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "step" "job_step_kind" NOT NULL,
    "account_id" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "status" "agent_run_status" NOT NULL DEFAULT 'running',
    "end_reason" "agent_run_end_reason",
    "summary" TEXT,
    "trigger_messages" JSONB NOT NULL,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "max_steps" INTEGER NOT NULL DEFAULT 12,
    "consecutive_protocol_errors" INTEGER NOT NULL DEFAULT 0,
    "budget_ms" INTEGER NOT NULL DEFAULT 60000,
    "accumulated_ms" INTEGER NOT NULL DEFAULT 0,
    "active_since" TIMESTAMPTZ,
    "claimed_by" TEXT,
    "heartbeat_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" "agent_step_kind" NOT NULL,
    "tool_use_id" TEXT,
    "name" TEXT,
    "input" JSONB,
    "result_content" TEXT,
    "result_summary" TEXT,
    "is_error" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "audit_verdict" "audit_verdict",
    "audit_attempts" INTEGER NOT NULL DEFAULT 0,
    "raw_response" TEXT,
    "tool_started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_pending_messages" (
    "run_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pending_messages_pkey" PRIMARY KEY ("run_id","message_id")
);

-- CreateTable
CREATE TABLE "agent_idempotency" (
    "run_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "client_msg_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_idempotency_pkey" PRIMARY KEY ("run_id","key")
);

-- CreateTable
CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_runs" (
    "id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "status" "sequence_run_status" NOT NULL DEFAULT 'running',
    "current_step_index" INTEGER NOT NULL DEFAULT 1,
    "vars" JSONB NOT NULL,
    "step_vars" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "sequence_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_run_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "account_role" "sequence_account_role" NOT NULL,
    "template" TEXT NOT NULL,
    "delay_seconds" INTEGER NOT NULL,
    "status" "sequence_step_status" NOT NULL DEFAULT 'pending',
    "resolved_vars" JSONB NOT NULL,
    "var_sources" JSONB NOT NULL,
    "scheduled_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "skipped_at" TIMESTAMPTZ,
    "account_id" TEXT,
    "client_msg_id" TEXT,
    "fail_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sequence_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_family" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "rotated_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_events" (
    "seq" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "inconsistencies" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "inconsistencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_platform_user_id_key" ON "accounts"("platform_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_gateway_group_id_key" ON "groups"("gateway_group_id");

-- CreateIndex
CREATE INDEX "group_members_account_id_idx" ON "group_members"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_client_msg_id_key" ON "messages"("client_msg_id");

-- CreateIndex
CREATE INDEX "messages_group_id_sent_at_id_idx" ON "messages"("group_id", "sent_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "messages_delivery_status_next_attempt_at_idx" ON "messages"("delivery_status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "messages_account_id_delivery_status_idx" ON "messages"("account_id", "delivery_status");

-- CreateIndex
CREATE UNIQUE INDEX "messages_group_id_msg_id_key" ON "messages"("group_id", "msg_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_attempts_message_id_attempt_no_key" ON "outbound_attempts"("message_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_event_id_key" ON "inbound_events"("event_id");

-- CreateIndex
CREATE INDEX "inbound_events_processed_at_received_at_idx" ON "inbound_events"("processed_at", "received_at");

-- CreateIndex
CREATE INDEX "inbound_events_group_id_idx" ON "inbound_events"("group_id");

-- CreateIndex
CREATE INDEX "jobs_status_next_run_at_idx" ON "jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "job_errors_job_id_idx" ON "job_errors"("job_id");

-- CreateIndex
CREATE INDEX "agent_runs_group_id_created_at_idx" ON "agent_runs"("group_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_status_heartbeat_at_idx" ON "agent_runs"("status", "heartbeat_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_steps_run_id_index_key" ON "agent_steps"("run_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "agent_steps_run_id_tool_use_id_key" ON "agent_steps"("run_id", "tool_use_id");

-- CreateIndex
CREATE INDEX "sequence_runs_group_id_created_at_idx" ON "sequence_runs"("group_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sequence_run_steps_client_msg_id_key" ON "sequence_run_steps"("client_msg_id");

-- CreateIndex
CREATE INDEX "sequence_run_steps_status_scheduled_at_idx" ON "sequence_run_steps"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_run_steps_run_id_index_key" ON "sequence_run_steps"("run_id", "index");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_token_family_idx" ON "sessions"("token_family");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "inconsistencies_resolved_at_created_at_idx" ON "inconsistencies"("resolved_at", "created_at");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_creator_account_id_fkey" FOREIGN KEY ("creator_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_attempts" ADD CONSTRAINT "outbound_attempts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_errors" ADD CONSTRAINT "job_errors_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_errors" ADD CONSTRAINT "job_errors_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_pending_messages" ADD CONSTRAINT "agent_pending_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_idempotency" ADD CONSTRAINT "agent_idempotency_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_idempotency" ADD CONSTRAINT "agent_idempotency_client_msg_id_fkey" FOREIGN KEY ("client_msg_id") REFERENCES "messages"("client_msg_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "sequences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_runs" ADD CONSTRAINT "sequence_runs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_run_steps" ADD CONSTRAINT "sequence_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sequence_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_run_steps" ADD CONSTRAINT "sequence_run_steps_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_run_steps" ADD CONSTRAINT "sequence_run_steps_client_msg_id_fkey" FOREIGN KEY ("client_msg_id") REFERENCES "messages"("client_msg_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- prisma migrate diff 只比对 schema 能表达的对象，这些索引 / CHECK 不会被报成漂移，
-- Prisma 也不会替你删改它们 —— 要改就再写一份迁移。schema.prisma 里对应字段旁有「约束见 …」注释。
-- 本迁移与建表同一份、同一事务，新表为空，不需要存量自查。
-- ============================================================================

-- 同群同一时刻至多一个 running 的 agent run（A5 第 1 条；多实例部署也成立）。
-- 第二个 create 撞的是唯一冲突（Prisma P2002），service 翻译成 409。
CREATE UNIQUE INDEX "agent_runs_one_running_per_group" ON "agent_runs" ("group_id") WHERE "status" = 'running';

-- 同群同一时刻至多一个 running 的序列运行（B1；并发两次启动恰好一个 201、一个 409）。
CREATE UNIQUE INDEX "sequence_runs_one_running_per_group" ON "sequence_runs" ("group_id") WHERE "status" = 'running';

-- event_cursor 单行：id 只能是 1。
ALTER TABLE "event_cursor" ADD CONSTRAINT "event_cursor_single_row" CHECK ("id" = 1);

-- accounts：rate_limited 必须带到期时刻（到期恢复 worker 按它排期）；version 只增不减。
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_rate_limited_has_until"
  CHECK ("status" <> 'rate_limited' OR "rate_limited_until" IS NOT NULL);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_version_nonneg" CHECK ("version" >= 0);

-- messages：failed / cancelled 时 failCode 必填（题目 2.3）；出站行必须有 clientMsgId 与 deliveryStatus
-- 且成对出现（入站行两者皆空）；重发总共只允许一次（A2）。
ALTER TABLE "messages" ADD CONSTRAINT "messages_fail_code_when_failed"
  CHECK ("delivery_status" IS NULL OR "delivery_status" NOT IN ('failed', 'cancelled') OR "fail_code" IS NOT NULL);
ALTER TABLE "messages" ADD CONSTRAINT "messages_outbound_fields_paired"
  CHECK (("client_msg_id" IS NULL) = ("delivery_status" IS NULL));
ALTER TABLE "messages" ADD CONSTRAINT "messages_resend_at_most_once"
  CHECK ("resend_count" >= 0 AND "resend_count" <= 1);

-- agent_runs：status 与 endReason 的对应关系（题目 2.3 agent-runs 的字段说明），
-- running 时 endReason 为空，其余状态必须带与之匹配的 endReason。
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_end_reason_matches_status" CHECK (
  ("status" = 'running'   AND "end_reason" IS NULL) OR
  ("status" = 'finished'  AND "end_reason" = 'final') OR
  ("status" = 'failed'    AND "end_reason" IN ('budget_exhausted', 'wall_clock', 'protocol_errors')) OR
  ("status" = 'blocked'   AND "end_reason" = 'audit_blocked') OR
  ("status" = 'cancelled' AND "end_reason" = 'cancelled')
);
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_counters_nonneg"
  CHECK ("step_count" >= 0 AND "consecutive_protocol_errors" >= 0 AND "accumulated_ms" >= 0 AND "budget_ms" > 0 AND "max_steps" > 0);

-- agent_steps：isError = true 时 errorCode 必填；协议错误步的 toolUseId / name / input 为 null（题目 2.3）。
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_error_code_when_error"
  CHECK (NOT "is_error" OR "error_code" IS NOT NULL);
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_protocol_error_fields_null"
  CHECK ("kind" <> 'protocol_error' OR ("tool_use_id" IS NULL AND "name" IS NULL AND "input" IS NULL));
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_index_positive" CHECK ("index" >= 1);

-- sequence_run_steps：index 从 1 起；delaySeconds 非负。
ALTER TABLE "sequence_run_steps" ADD CONSTRAINT "sequence_run_steps_index_positive" CHECK ("index" >= 1);
ALTER TABLE "sequence_run_steps" ADD CONSTRAINT "sequence_run_steps_delay_nonneg" CHECK ("delay_seconds" >= 0);
