CREATE TABLE "proactive_nightly_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"review_date" date NOT NULL,
	"timezone" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"automation_id" uuid NOT NULL,
	"event_id" uuid,
	"learning_event_id" uuid,
	"learning_memory_version" varchar(64),
	"skipped_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_nightly_cycles_kind_check" CHECK ("proactive_nightly_cycles"."kind" IN ('learning', 'planning'))
);
--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "proactive_learning_enabled" boolean;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "proactive_planning_enabled" boolean;--> statement-breakpoint
ALTER TABLE "proactive_nightly_cycles" ADD CONSTRAINT "proactive_nightly_cycles_automation_id_workflow_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."workflow_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_nightly_cycles" ADD CONSTRAINT "proactive_nightly_cycles_event_id_chat_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."chat_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_nightly_cycles" ADD CONSTRAINT "proactive_nightly_cycles_learning_event_id_chat_events_id_fk" FOREIGN KEY ("learning_event_id") REFERENCES "public"."chat_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_nightly_cycles_owner_day_kind" ON "proactive_nightly_cycles" USING btree ("org_id","user_id","review_date","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_nightly_cycles_event" ON "proactive_nightly_cycles" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "proactive_nightly_cycles_automation" ON "proactive_nightly_cycles" USING btree ("automation_id");