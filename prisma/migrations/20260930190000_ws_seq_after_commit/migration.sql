-- ws_events：seq 从「写入时分配的自增主键」改成「提交之后由排号器补上的推送序号」。自增值在 INSERT 时分配、
-- 提交顺序却可能不同：先拿到 10 的事务晚于拿到 11 的事务提交时，按「seq > 水位」轮询的读者已经把水位推过 10，
-- 10 永远不推、重连也不补。见 schema.prisma 的 WsEvent 与 src/services/ws-events.ts 的 assignWsSeqs。
-- 原 seq 列就地改名为 id（保留自增序列与既有值），不 DROP + ADD。
ALTER TABLE "ws_events" DROP CONSTRAINT "ws_events_pkey";
ALTER TABLE "ws_events" RENAME COLUMN "seq" TO "id";
ALTER SEQUENCE "ws_events_seq_seq" RENAME TO "ws_events_id_seq";
ALTER TABLE "ws_events" ADD CONSTRAINT "ws_events_pkey" PRIMARY KEY ("id");
ALTER TABLE "ws_events" ADD COLUMN "seq" INTEGER;
-- schema-backfill: 存量事件已按旧 seq（= 现在的 id）推给过客户端、客户端的 sinceSeq 指着它们；新列必须沿用旧值，
-- 排号器从 max(seq) 往后接着排，否则重连补发会重复或错位
UPDATE "ws_events" SET "seq" = "id";
CREATE UNIQUE INDEX "ws_events_seq_key" ON "ws_events"("seq");
-- 排号器按 id 顺序找还没排号的行（部分索引，schema 表达不了，db:check 不比它）
CREATE INDEX "ws_events_unsequenced" ON "ws_events" ("id") WHERE "seq" IS NULL;
