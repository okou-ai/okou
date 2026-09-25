ALTER TABLE "chat_thread_drafts" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "idx_chat_thread_drafts_user" ON "chat_thread_drafts" USING btree ("user_id");--> statement-breakpoint
-- Every API since #36230 writes a thread's draft to both stores in one
-- transaction, so an existing child row is already current. Only drafts last
-- saved before that bridge exist solely in the legacy columns.
INSERT INTO "chat_thread_drafts" ("chat_thread_id", "user_id", "draft_user_message", "draft_attachments")
SELECT "id", "user_id", "draft_user_message", "draft_attachments"
FROM "chat_threads"
WHERE "draft_user_message" IS NOT NULL
ON CONFLICT ("chat_thread_id") DO NOTHING;--> statement-breakpoint
UPDATE "chat_thread_drafts" AS "draft"
SET "user_id" = "thread"."user_id"
FROM "chat_threads" AS "thread"
WHERE "thread"."id" = "draft"."chat_thread_id"
  AND "draft"."user_id" IS NULL;
