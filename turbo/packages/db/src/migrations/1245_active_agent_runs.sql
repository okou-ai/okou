CREATE TABLE "active_agent_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid,
	"last_heartbeat_at" timestamp NOT NULL,
	"activity_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activity_revision" text DEFAULT 'empty' NOT NULL,
	"summary" text,
	"summary_revision" text,
	"next_attempt_at" timestamp,
	"claim_id" uuid,
	"claim_expires_at" timestamp,
	CONSTRAINT "active_agent_runs_activity_entries_bound" CHECK (jsonb_typeof("active_agent_runs"."activity_entries") = 'array' AND jsonb_array_length("active_agent_runs"."activity_entries") <= 16 AND octet_length("active_agent_runs"."activity_entries"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "active_agent_runs" ADD CONSTRAINT "active_agent_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "active_agent_runs_org_idx" ON "active_agent_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "active_agent_runs_user_idx" ON "active_agent_runs" USING btree ("user_id");--> statement-breakpoint
-- Seed rows for runs that are already active. Runs created by an older API
-- during rollout are seeded by the follow-up migration that switches readers.
INSERT INTO "active_agent_runs" ("run_id", "org_id", "user_id", "chat_thread_id", "last_heartbeat_at")
SELECT "id", "org_id", "user_id", "chat_thread_id", COALESCE("last_heartbeat_at", "created_at")
FROM "agent_runs"
WHERE "status" IN ('queued', 'pending', 'running')
ON CONFLICT ("run_id") DO NOTHING;
