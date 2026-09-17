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
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "morning_brief_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "morning_brief_deliveries_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "fk_morning_brief_deliveries_member" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."org_members_metadata"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_attempt_unique" ON "morning_brief_deliveries" USING btree ("org_id","user_id","result_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_chat_event_unique" ON "morning_brief_deliveries" USING btree ("chat_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "morning_brief_deliveries_outbox_unique" ON "morning_brief_deliveries" USING btree ("email_outbox_id");--> statement-breakpoint
CREATE INDEX "morning_brief_deliveries_thread_idx" ON "morning_brief_deliveries" USING btree ("chat_thread_id","delivered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "morning_brief_deliveries_agent_idx" ON "morning_brief_deliveries" USING btree ("agent_id");