-- Retire the account-erasure mechanism after active-run migrations 1249/1250.
-- Old API instances touching these tables during deployment will fail;
-- rollback to an API below this migration is unsupported by explicit decision.
ALTER TABLE "account_erasure_ingress" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_replay" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_pages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_selector_dependencies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_sinks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_erasure_work" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blob_upload_intents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_content_erasure_subjects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pi_stable_context_erasure_fences" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
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