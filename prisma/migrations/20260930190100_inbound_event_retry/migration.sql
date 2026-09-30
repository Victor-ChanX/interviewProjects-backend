-- inbound_events：处理失败 / 入册后没处理（进程死在两者之间）的事件按 next_attempt_at 自动重试。
ALTER TABLE "inbound_events" ADD COLUMN "next_attempt_at" TIMESTAMPTZ;
-- schema-backfill: 存量里处理失败 / 未处理的事件原本没有任何重试路径；新列给它们排上「现在」，
-- 否则这些事件的内容就只留在表里、永远进不了时间线
UPDATE "inbound_events" SET "next_attempt_at" = CURRENT_TIMESTAMP WHERE "processed_at" IS NULL;
CREATE INDEX "inbound_events_next_attempt_at_idx" ON "inbound_events"("next_attempt_at");
