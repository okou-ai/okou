ALTER TABLE "slack_chat_ingress" DROP CONSTRAINT "chk_slack_chat_ingress_status";--> statement-breakpoint
UPDATE "slack_chat_ingress"
SET "status" = 'terminal',
    "last_error_class" = 'legacy_terminal_failure',
    "retry_at" = NULL
WHERE "status" = 'failed';--> statement-breakpoint
ALTER TABLE "slack_chat_ingress" ADD CONSTRAINT "chk_slack_chat_ingress_status" CHECK ("slack_chat_ingress"."status" IN ('pending', 'processing', 'retryable', 'processed', 'terminal'));