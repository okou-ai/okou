CREATE TABLE "morning_brief_schedule_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"org_id" text,
	"owner_user_id" text,
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
            "morning_brief_schedule_claims"."settlement" IN ('completed', 'failed', 'pre_run_failure', 'revoked')
            AND "morning_brief_schedule_claims"."settled_at" IS NOT NULL
          )),
	CONSTRAINT "chk_morning_brief_schedule_claims_owner" CHECK ((
            "morning_brief_schedule_claims"."org_id" IS NOT NULL AND "morning_brief_schedule_claims"."owner_user_id" IS NOT NULL
          ) OR (
            "morning_brief_schedule_claims"."settlement" = 'revoked'
            AND "morning_brief_schedule_claims"."org_id" IS NULL
            AND "morning_brief_schedule_claims"."owner_user_id" IS NULL
          )),
	CONSTRAINT "chk_morning_brief_schedule_claims_sequence" CHECK ("morning_brief_schedule_claims"."claim_sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "morning_brief_schedule_claims" ADD CONSTRAINT "morning_brief_schedule_claims_automation_id_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_anchor" ON "morning_brief_schedule_claims" USING btree ("automation_id","scheduled_anchor_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_queue_event" ON "morning_brief_schedule_claims" USING btree ("queue_event_id") WHERE "morning_brief_schedule_claims"."queue_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_run" ON "morning_brief_schedule_claims" USING btree ("run_id") WHERE "morning_brief_schedule_claims"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_sequence" ON "morning_brief_schedule_claims" USING btree ("automation_id","claim_sequence");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_schedule_claims_owner" ON "morning_brief_schedule_claims" USING btree ("org_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_schedule_claims_owner_user" ON "morning_brief_schedule_claims" USING btree ("owner_user_id");