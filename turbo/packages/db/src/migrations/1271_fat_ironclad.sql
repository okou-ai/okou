CREATE TABLE "runner_wss_tickets" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"runner_id" uuid NOT NULL,
	"origin" varchar(300) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "runner_wss_tickets" ADD CONSTRAINT "runner_wss_tickets_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_wss_tickets_run_expires_idx" ON "runner_wss_tickets" USING btree ("run_id","expires_at");--> statement-breakpoint
CREATE INDEX "runner_wss_tickets_expires_idx" ON "runner_wss_tickets" USING btree ("expires_at");