-- Retire the whole account-erasure mechanism (EPIC #33745): the B1 job,
-- work, page, sink and selector tables, the dormant Clerk bridge ingress and
-- replay tables, chat content deletion receipts, the Pi stable-context
-- erasure fence, shared blob upload intents and the blobs erasure columns.
-- No API at this revision reads or writes them; the clerk-user-deletion job
-- runs only the legacy cleanup. Explicit decision: no rollback-window
-- deferral. APIs older than this revision fail while they overlap it, and
-- rolling the API back below this revision is unsupported.
DROP TABLE "account_erasure_ingress" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_replay" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_pages" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_selector_dependencies" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_sinks" CASCADE;--> statement-breakpoint
DROP TABLE "account_erasure_work" CASCADE;--> statement-breakpoint
DROP TABLE "blob_upload_intents" CASCADE;--> statement-breakpoint
DROP TABLE "chat_content_erasure_subjects" CASCADE;--> statement-breakpoint
DROP TABLE "pi_stable_context_erasure_fences" CASCADE;--> statement-breakpoint
ALTER TABLE "blobs" DROP CONSTRAINT "blobs_erasure_pending_zero_refs";--> statement-breakpoint
ALTER TABLE "blobs" DROP COLUMN "erasure_pending";--> statement-breakpoint
ALTER TABLE "blobs" DROP COLUMN "erasure_eligible_at";