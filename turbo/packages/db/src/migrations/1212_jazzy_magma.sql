CREATE TABLE "morning_brief_native_schedule_skips" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"owner_epoch" integer NOT NULL,
	"scheduled_anchor_at" timestamp NOT NULL,
	"skipped_at" timestamp NOT NULL,
	CONSTRAINT "morning_brief_native_schedule_skips_pk" PRIMARY KEY("org_id","user_id","owner_epoch","scheduled_anchor_at")
);
--> statement-breakpoint
CREATE TABLE "workflow_schedule_skips" (
	"automation_id" uuid NOT NULL,
	"scheduled_anchor_at" timestamp NOT NULL,
	"skipped_at" timestamp NOT NULL,
	CONSTRAINT "workflow_schedule_skips_pk" PRIMARY KEY("automation_id","scheduled_anchor_at")
);
--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD COLUMN "deferred_anchor_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD COLUMN "deferred_until" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD COLUMN "deferred_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "morning_brief_native_schedule_skips" ADD CONSTRAINT "fk_morning_brief_native_schedule_skips_owner" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."morning_brief_native_schedules"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedule_skips" ADD CONSTRAINT "workflow_schedule_skips_automation_id_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_morning_brief_native_schedule_skips_at" ON "morning_brief_native_schedule_skips" USING btree ("skipped_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedule_skips_at" ON "workflow_schedule_skips" USING btree ("skipped_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_automations_deferred_retry" ON "workflow_automations" USING btree ("deferred_until","next_run_at") WHERE "workflow_automations"."deferred_until" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_deferral_pair_check" CHECK ((
          "workflow_automations"."deferred_anchor_at" IS NULL
          AND "workflow_automations"."deferred_until" IS NULL
          AND "workflow_automations"."deferred_reason" IS NULL
        ) OR (
          "workflow_automations"."deferred_anchor_at" IS NOT NULL
          AND "workflow_automations"."deferred_until" IS NOT NULL
          AND "workflow_automations"."deferred_reason" IS NOT NULL
        ));