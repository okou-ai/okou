CREATE TABLE "chat_content_erasure_subjects" (
	"subject_kind" varchar(16) NOT NULL,
	"subject_id" text NOT NULL,
	"source_reference" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"next_sweep_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_content_erasure_subjects_subject_kind_subject_id_pk" PRIMARY KEY("subject_kind","subject_id"),
	CONSTRAINT "chat_content_erasure_subject_kind" CHECK ("chat_content_erasure_subjects"."subject_kind" IN ('user', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "chat_event_sequences" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"last_seq_id" bigint NOT NULL,
	CONSTRAINT "chat_event_sequences_nonnegative" CHECK ("chat_event_sequences"."last_seq_id" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_event_write_control" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"activated_at" timestamp,
	CONSTRAINT "chat_event_write_control_singleton" CHECK ("chat_event_write_control"."id" = 'global')
);
--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "is_group" boolean;--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "group_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "channel" varchar(16);--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "from_number" varchar(254);--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "to_number" varchar(254);--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "agentphone_agent_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agentphone_chat_thread_routes" ADD COLUMN "delivery_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_agent_run_context" ADD COLUMN "source_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_agent_run_context" ADD COLUMN "source_org_id" text;--> statement-breakpoint
ALTER TABLE "github_chat_thread_routes" ADD COLUMN "subject_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "teams_chat_thread_routes" ADD COLUMN "conversation_type" varchar(32);--> statement-breakpoint
ALTER TABLE "teams_chat_thread_routes" ADD COLUMN "channel_id" varchar(255);--> statement-breakpoint
ALTER TABLE "teams_chat_thread_routes" ADD COLUMN "service_url" text;--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD COLUMN "message_thread_id" integer;--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD COLUMN "chat_type" varchar(32);--> statement-breakpoint
ALTER TABLE "telegram_chat_thread_routes" ADD COLUMN "delivery_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "chat_event_sequences" ADD CONSTRAINT "chat_event_sequences_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_content_erasure_next_sweep" ON "chat_content_erasure_subjects" USING btree ("next_sweep_at","subject_kind","subject_id") WHERE "chat_content_erasure_subjects"."completed_at" IS NOT NULL;
