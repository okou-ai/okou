-- Preserve exact cleanup identities, including dormant current previews.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT "chat_thread_id", "object_key", "created_at"
  FROM "browser_session_screenshots"
  WHERE ($1::uuid IS NULL OR "chat_thread_id" > $1::uuid)
  ORDER BY "chat_thread_id"
  LIMIT 1000
), queued AS (
  INSERT INTO "browser_session_screenshot_deletions"
    ("object_key", "chat_thread_id", "created_at")
  SELECT "object_key", "chat_thread_id", "created_at" FROM batch
  ON CONFLICT ("object_key") DO NOTHING
)
SELECT (
  SELECT "chat_thread_id" FROM batch ORDER BY "chat_thread_id" DESC LIMIT 1
) AS next_cursor;--> statement-breakpoint
DROP TABLE "browser_session_resize_states" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_session_instances" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_sessions" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_thread_profiles" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_profiles" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_session_tab_snapshots" RESTRICT;--> statement-breakpoint
DROP TABLE "browser_session_screenshots" RESTRICT;
