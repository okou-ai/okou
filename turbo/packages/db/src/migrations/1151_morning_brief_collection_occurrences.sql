CREATE TABLE "morning_brief_collection_occurrences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scheduled_for" timestamp NOT NULL,
	"collection_kind" text NOT NULL,
	"collection_version" integer NOT NULL,
	"window_start" timestamp NOT NULL,
	"window_end" timestamp NOT NULL,
	"timezone" text NOT NULL,
	"membership_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_workspace_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"outcome" text,
	"retry_after_seconds" integer,
	"channel_count" integer,
	"thread_count" integer,
	"message_count" integer,
	"request_count" integer,
	"truncated" boolean,
	"claimed_at" timestamp NOT NULL,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_collection_occurrences_pk" PRIMARY KEY("org_id","user_id","scheduled_for","collection_kind","collection_version"),
	CONSTRAINT "chk_morning_brief_collection_occurrence_window" CHECK ("morning_brief_collection_occurrences"."window_end" > "morning_brief_collection_occurrences"."window_start"),
	CONSTRAINT "chk_morning_brief_collection_occurrence_attempt" CHECK ("morning_brief_collection_occurrences"."attempt" >= 1),
	CONSTRAINT "chk_morning_brief_collection_occurrence_lease" CHECK (("morning_brief_collection_occurrences"."status" = 'running') = ("morning_brief_collection_occurrences"."lease_token" IS NOT NULL)
          AND ("morning_brief_collection_occurrences"."lease_token" IS NULL) = ("morning_brief_collection_occurrences"."lease_expires_at" IS NULL)),
	CONSTRAINT "chk_morning_brief_collection_occurrence_outcome" CHECK (("morning_brief_collection_occurrences"."status" = 'running') = ("morning_brief_collection_occurrences"."outcome" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "morning_brief_collection_occurrences" ADD CONSTRAINT "fk_morning_brief_collection_occurrences_member" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."org_members_metadata"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_collection_occurrences" ADD CONSTRAINT "fk_morning_brief_collection_occurrences_agent" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_morning_brief_collection_occurrences_user" ON "morning_brief_collection_occurrences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_collection_occurrences_agent" ON "morning_brief_collection_occurrences" USING btree ("agent_id");