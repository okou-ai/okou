CREATE TABLE "morning_brief_deliveries" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"collection_kind" text NOT NULL,
	"collection_version" integer NOT NULL,
	"execution_purpose" text NOT NULL,
	"result_attempt_id" uuid NOT NULL,
	"membership_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"chat_event_id" uuid NOT NULL,
	"result_digest" text NOT NULL,
	"email_resolution" text NOT NULL,
	"email_outbox_id" uuid,
	"delivered_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_deliveries_pk" PRIMARY KEY("org_id","user_id","scheduled_for","collection_kind","collection_version")
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
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "morning_brief_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "morning_brief_deliveries_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "fk_morning_brief_deliveries_member" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."org_members_metadata"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_schedule_claims" ADD CONSTRAINT "morning_brief_schedule_claims_automation_id_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_attempt_unique" ON "morning_brief_deliveries" USING btree ("org_id","user_id","result_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_chat_event_unique" ON "morning_brief_deliveries" USING btree ("chat_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_outbox_unique" ON "morning_brief_deliveries" USING btree ("email_outbox_id");--> statement-breakpoint
CREATE INDEX "morning_brief_deliveries_thread_idx" ON "morning_brief_deliveries" USING btree ("chat_thread_id","delivered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "morning_brief_deliveries_agent_idx" ON "morning_brief_deliveries" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_anchor" ON "morning_brief_schedule_claims" USING btree ("automation_id","scheduled_anchor_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_queue_event" ON "morning_brief_schedule_claims" USING btree ("queue_event_id") WHERE "morning_brief_schedule_claims"."queue_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_run" ON "morning_brief_schedule_claims" USING btree ("run_id") WHERE "morning_brief_schedule_claims"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_schedule_claims_sequence" ON "morning_brief_schedule_claims" USING btree ("automation_id","claim_sequence");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_schedule_claims_owner" ON "morning_brief_schedule_claims" USING btree ("org_id","owner_user_id");