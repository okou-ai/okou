-- okou:non-transactional
-- Discover sparse repair candidates without blocking snapshot publication.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build on retry.
DROP INDEX CONCURRENTLY IF EXISTS "chat_event_snapshots_repair_candidates_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_event_snapshots_repair_candidates_idx" ON "chat_event_snapshots" USING btree ("archive_schema_version","chat_thread_id") WHERE (
          "chat_event_snapshots"."last_seq_id" <= 0
          OR "chat_event_snapshots"."terminal_seq_id" IS NULL
          OR btrim("chat_event_snapshots"."object_key") = ''
          OR NOT ("chat_event_snapshots"."object_key" ~ '-[0-9a-f]{64}[.]ndjson[.]gz$')
          OR "chat_event_snapshots"."object_key" ~ '^chat-events/[0-9a-f-]{36}/[0-9]+-[0-9a-f]{64}[.]ndjson[.]gz$'
        );
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
