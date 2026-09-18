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
CREATE TABLE "morning_brief_schedule_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"scheduled_anchor_at" timestamp NOT NULL,
	"claimed_at" timestamp NOT NULL,
	"claim_sequence" integer NOT NULL,
	"queue_event_id" uuid,
	"run_id" uuid,
	"queue_disposition" varchar(16) DEFAULT 'queued' NOT NULL,
	"settlement" varchar(16) DEFAULT 'unsettled' NOT NULL,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_morning_brief_schedule_claims_queue_disposition" CHECK ("morning_brief_schedule_claims"."queue_disposition" IN ('queued', 'claimed')),
	CONSTRAINT "chk_morning_brief_schedule_claims_settlement" CHECK ((
            "morning_brief_schedule_claims"."settlement" = 'unsettled' AND "morning_brief_schedule_claims"."settled_at" IS NULL
          ) OR (
            "morning_brief_schedule_claims"."settlement" IN ('completed', 'failed', 'pre_run_failure')
            AND "morning_brief_schedule_claims"."settled_at" IS NOT NULL
          )),
	CONSTRAINT "chk_morning_brief_schedule_claims_sequence" CHECK ("morning_brief_schedule_claims"."claim_sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "morning_brief_generations" DROP CONSTRAINT "chk_morning_brief_generation_purpose";--> statement-breakpoint
ALTER TABLE "morning_brief_native_occurrences" ADD CONSTRAINT "fk_morning_brief_native_occurrences_schedule" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."morning_brief_native_schedules"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_native_schedules" ADD CONSTRAINT "fk_morning_brief_native_schedules_thread" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_schedule_claims" ADD CONSTRAINT "morning_brief_schedule_claims_automation_id_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_morning_brief_native_occurrences_attempt" ON "morning_brief_native_occurrences" USING btree ("generation_attempt_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_occurrences_open" ON "morning_brief_native_occurrences" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_occurrences_delivery" ON "morning_brief_native_occurrences" USING btree ("delivery_pending");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_due" ON "morning_brief_native_schedules" USING btree ("schedule_owner","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_phase" ON "morning_brief_native_schedules" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_user" ON "morning_brief_native_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_agent" ON "morning_brief_native_schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedules_thread" ON "morning_brief_native_schedules" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_anchor" ON "morning_brief_schedule_claims" USING btree ("automation_id","scheduled_anchor_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_queue_event" ON "morning_brief_schedule_claims" USING btree ("queue_event_id") WHERE "morning_brief_schedule_claims"."queue_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_run" ON "morning_brief_schedule_claims" USING btree ("run_id") WHERE "morning_brief_schedule_claims"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_sequence" ON "morning_brief_schedule_claims" USING btree ("automation_id","claim_sequence");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_schedule_claims_owner" ON "morning_brief_schedule_claims" USING btree ("org_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_purpose" CHECK ("morning_brief_generations"."execution_purpose" IN ('preview', 'production'));