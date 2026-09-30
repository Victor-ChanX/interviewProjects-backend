-- C1 媒体文件：message 事件带 mediaUrl 时由 media-worker 下载到本地 MEDIA_DIR，路径记在 local_file_path；
-- 超过保留期由同一个 worker 清理（先清 local_file_path 再删盘上的文件）。见 src/services/media-service.ts。
ALTER TABLE "messages" ADD COLUMN "local_file_path" TEXT;
ALTER TABLE "messages" ADD COLUMN "media_next_attempt_at" TIMESTAMPTZ;
ALTER TABLE "messages" ADD COLUMN "media_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "messages" ADD COLUMN "media_error" TEXT;
ALTER TABLE "messages" ADD COLUMN "media_fetched_at" TIMESTAMPTZ;
ALTER TABLE "messages" ADD COLUMN "media_purged_at" TIMESTAMPTZ;
-- schema-backfill: 存量里带 mediaUrl 的消息此前从没下载过；新列给它们排上「现在」，否则永远不会被下载
UPDATE "messages" SET "media_next_attempt_at" = CURRENT_TIMESTAMP WHERE "media_url" IS NOT NULL;
CREATE INDEX "messages_media_next_attempt_at_idx" ON "messages"("media_next_attempt_at");
CREATE INDEX "messages_media_fetched_at_idx" ON "messages"("media_fetched_at");
