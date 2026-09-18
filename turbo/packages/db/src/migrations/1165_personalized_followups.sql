CREATE TABLE "followup_evidence" (
	"input_event_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" varchar(1500) NOT NULL,
	"kind" text NOT NULL,
	"origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "followup_evidence_origins_bound" CHECK (jsonb_typeof("followup_evidence"."origins") = 'array' AND jsonb_array_length("followup_evidence"."origins") <= 3)
);
--> statement-breakpoint
CREATE TABLE "followup_user_profiles" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"preferences" varchar(1200),
	"source_event_ids" uuid[] DEFAULT '{}' NOT NULL,
	"evidence_version" integer DEFAULT 0 NOT NULL,
	"processed_version" integer DEFAULT 0 NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "followup_user_profiles_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "followup_profile_versions" CHECK ("followup_user_profiles"."processed_version" >= 0 AND "followup_user_profiles"."evidence_version" >= "followup_user_profiles"."processed_version")
);
--> statement-breakpoint
ALTER TABLE "followup_evidence" ADD CONSTRAINT "followup_evidence_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "followup_evidence_thread_idx" ON "followup_evidence" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "followup_evidence_owner_idx" ON "followup_evidence" USING btree ("org_id","user_id","completed_at");--> statement-breakpoint
CREATE INDEX "followup_evidence_retention_idx" ON "followup_evidence" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "followup_profiles_pending_idx" ON "followup_user_profiles" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "followup_profiles_user_idx" ON "followup_user_profiles" USING btree ("user_id");