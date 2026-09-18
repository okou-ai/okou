CREATE TABLE "morning_brief_native_occurrences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"owner_epoch" integer NOT NULL,
	"membership_id" text NOT NULL,
	"timezone" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"outcome" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"attempt" integer DEFAULT 1 NOT NULL,
	"generation_attempt_id" uuid,
	"delivery_pending" boolean DEFAULT false NOT NULL,
	"deferred_until" timestamp,
	"defer_attempt" integer DEFAULT 0 NOT NULL,
	"defer_reason" text,
	"claimed_at" timestamp NOT NULL,
	"settled_at" timestamp,
	"settled_next_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_native_occurrences_pk" PRIMARY KEY("org_id","user_id","scheduled_for")
);
--> statement-breakpoint
CREATE TABLE "morning_brief_native_schedules" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"cron_expression" text,
	"timezone" text NOT NULL,
	"next_run_at" timestamp,
	"schedule_owner" text,
	"phase" text NOT NULL,
	"target" text NOT NULL,
	"owner_epoch" integer NOT NULL,
	"membership_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid,
	"legacy_workflow_id" uuid,
	"legacy_automation_id" uuid,
	"draining_epoch" integer,
	"drain_deadline_at" timestamp,
	"drain_unresolved_reason" text,
	"materialized_at" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_native_schedules_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "morning_brief_generations" DROP CONSTRAINT "chk_morning_brief_generation_purpose";--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD COLUMN "native_owner_epoch" integer;--> statement-breakpoint
ALTER TABLE "morning_brief_native_occurrences" ADD CONSTRAINT "fk_morning_brief_native_occurrences_schedule" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."morning_brief_native_schedules"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_native_schedules" ADD CONSTRAINT "fk_morning_brief_native_schedules_thread" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_morning_brief_native_occurrences_attempt" ON "morning_brief_native_occurrences" USING btree ("generation_attempt_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_occurrences_open" ON "morning_brief_native_occurrences" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_occurrences_delivery" ON "morning_brief_native_occurrences" USING btree ("delivery_pending");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_due" ON "morning_brief_native_schedules" USING btree ("schedule_owner","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_phase" ON "morning_brief_native_schedules" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_user" ON "morning_brief_native_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_agent" ON "morning_brief_native_schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_thread" ON "morning_brief_native_schedules" USING btree ("chat_thread_id");--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_purpose" CHECK ("morning_brief_generations"."execution_purpose" IN ('preview', 'production'));