-- Discord replies are sent fire and forget; nothing reads or writes
-- discord_chat_deliveries. Dropping it also removes its FKs into chat_events,
-- which were the only reason for chat_events_id_thread_unique.
-- idx_chat_events_run_id is covered by chat_events_run_event_seq_unique
-- (run_id, run_event_sequence_number).
DROP TABLE "discord_chat_deliveries";
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_id_thread_unique";
--> statement-breakpoint
DROP INDEX "idx_chat_events_run_id";
