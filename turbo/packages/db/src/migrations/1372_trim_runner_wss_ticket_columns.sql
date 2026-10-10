DROP INDEX "runner_wss_tickets_run_expires_idx";--> statement-breakpoint
DROP INDEX "runner_wss_tickets_expires_idx";--> statement-breakpoint
CREATE INDEX "runner_wss_tickets_run_created_idx" ON "runner_wss_tickets" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_wss_tickets_created_idx" ON "runner_wss_tickets" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "runner_wss_tickets" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "runner_wss_tickets" DROP COLUMN "revoked_at";