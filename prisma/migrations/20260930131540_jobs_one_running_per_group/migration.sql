-- 同群同一时刻至多一个 running 的 job（#16 leave-all：建群 job 还在跑、或已有一个 leave-all 在跑时，
-- 再发 leave-all 撞唯一冲突 → Prisma P2002 → service 翻译成 409 JOB_ALREADY_RUNNING）。
-- Prisma schema 表达不了部分唯一索引，手写；schema.prisma 的 Job 模型旁有「约束见 …」注释。
-- 存量自查：已有的 job 都由 POST /api/groups 建，每个群恰好一个，所以这里先列出冲突（有则整份迁移失败、不猜）。
DO $$
DECLARE
  dup TEXT;
BEGIN
  SELECT string_agg(group_id, ', ') INTO dup
  FROM (
    SELECT group_id FROM "jobs"
    WHERE "status" = 'running' AND group_id IS NOT NULL
    GROUP BY group_id HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'jobs：以下群同时有多个 running 的 job，先处理再迁移：%', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "jobs_one_running_per_group" ON "jobs" ("group_id") WHERE "status" = 'running';
