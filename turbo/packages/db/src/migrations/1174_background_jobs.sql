CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"handler_version" integer NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "background_jobs_status_check" CHECK ("background_jobs"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "background_jobs_handler_version_check" CHECK ("background_jobs"."handler_version" > 0),
	CONSTRAINT "background_jobs_failure_count_check" CHECK ("background_jobs"."failure_count" >= 0),
	CONSTRAINT "background_jobs_lease_check" CHECK ((
          "background_jobs"."status" = 'running' AND
          "background_jobs"."lease_id" IS NOT NULL AND "background_jobs"."lease_expires_at" IS NOT NULL
        ) OR (
          "background_jobs"."status" <> 'running' AND
          "background_jobs"."lease_id" IS NULL AND "background_jobs"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "background_jobs_completion_check" CHECK ((
          "background_jobs"."status" IN ('pending', 'running') AND "background_jobs"."completed_at" IS NULL
        ) OR (
          "background_jobs"."status" IN ('completed', 'failed', 'cancelled') AND "background_jobs"."completed_at" IS NOT NULL
        ))
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "execution_mode" text;--> statement-breakpoint
CREATE INDEX "idx_background_jobs_pending" ON "background_jobs" USING btree ("kind","handler_version","available_at","id") WHERE "background_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_background_jobs_expired_lease" ON "background_jobs" USING btree ("kind","handler_version","lease_expires_at","id") WHERE "background_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_background_jobs_owner" ON "background_jobs" USING btree ("user_id","org_id");