CREATE TABLE "runner_file_download_grants" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"runner_id" uuid NOT NULL,
	"origin" varchar(300) NOT NULL,
	"path" text[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "runner_file_download_grants_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "file_download_service_version" integer;--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "file_download_service_seen_at" timestamp;--> statement-breakpoint
ALTER TABLE "runner_file_download_grants" ADD CONSTRAINT "runner_file_download_grants_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_file_download_grants_expiry_idx" ON "runner_file_download_grants" USING btree ("expires_at");