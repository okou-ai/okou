ALTER TABLE "slack_chat_ingress" DROP CONSTRAINT "chk_slack_chat_ingress_status";--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD COLUMN "processing_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD COLUMN "retry_at" timestamp;--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD COLUMN "last_error_class" varchar(128);--> statement-breakpoint
UPDATE "slack_chat_ingress"
SET "status" = 'terminal', "last_error_class" = 'legacy_terminal_failure'
WHERE "status" = 'failed';--> statement-breakpoint
CREATE INDEX "idx_slack_chat_ingress_retry_sweep" ON "slack_chat_ingress" USING btree ("status","retry_at","updated_at");--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "chk_slack_chat_ingress_processing_attempt_count" CHECK ("slack_chat_ingress"."processing_attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "chk_slack_chat_ingress_status" CHECK ("slack_chat_ingress"."status" IN ('pending', 'processing', 'retryable', 'processed', 'failed', 'terminal'));