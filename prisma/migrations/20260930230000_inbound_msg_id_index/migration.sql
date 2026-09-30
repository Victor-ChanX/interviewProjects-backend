-- 自己消息的回流判重（「同 msgId 的 message 事件处理过没有」）按 payload->>'msgId' 查 inbound_events：表只增不减，
-- 没有索引就是全表扫。表达式 + 部分索引，schema 表达不了（手写，db:check 不比它）。见 src/services/inbound-service.ts 的 handleMessage。
CREATE INDEX "inbound_events_processed_message_msg_id"
  ON "inbound_events" ((payload->>'msgId'))
  WHERE "type" = 'message' AND "processed_at" IS NOT NULL;
