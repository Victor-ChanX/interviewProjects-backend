-- 定时序列调度器心跳（B1 重启重排）：「停机期间过期」改按库里的调度器心跳空档判定，不再按单个实例的启动时刻 ——
-- 多副本滚动发布时新实例不会把刚到点的步骤误判为过期。见 src/services/sequence-service.ts 的 recordSchedulerBeat。
CREATE TABLE "scheduler_heartbeats" (
    "name" TEXT NOT NULL,
    "beat_at" TIMESTAMPTZ NOT NULL,
    "down_from" TIMESTAMPTZ,
    "down_until" TIMESTAMPTZ,

    CONSTRAINT "scheduler_heartbeats_pkey" PRIMARY KEY ("name")
);
