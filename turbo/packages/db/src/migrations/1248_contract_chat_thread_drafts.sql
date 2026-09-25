-- Release 1 (#36897) writes user_id on every draft row and deletes the row on
-- clear. Rows written by the earlier dual-writing API can still lack an owner
-- or be a cleared tombstone with both draft values null. Fill owners from the
-- thread, then drop tombstones and rows whose thread no longer exists.
UPDATE "chat_thread_drafts" AS "draft"
SET "user_id" = "thread"."user_id"
FROM "chat_threads" AS "thread"
WHERE "thread"."id" = "draft"."chat_thread_id"
  AND "draft"."user_id" IS NULL;--> statement-breakpoint
DELETE FROM "chat_thread_drafts"
WHERE "user_id" IS NULL OR "draft_user_message" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" DROP CONSTRAINT "chat_thread_drafts_draft_user_message_check";--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" ALTER COLUMN "draft_user_message" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_thread_drafts_thread_user" ON "chat_thread_drafts" USING btree ("chat_thread_id","user_id");