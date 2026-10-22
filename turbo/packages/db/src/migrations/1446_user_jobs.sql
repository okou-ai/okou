CREATE TABLE "user_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"source_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"work" jsonb DEFAULT '{"progress":"","explanation":"","authorization":null,"processedInputIds":[],"currentResultId":null}'::jsonb NOT NULL,
	"authorization_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"viewed_result_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_jobs_status_check" CHECK ("user_jobs"."status" IN ('active', 'waiting_decision', 'waiting_authorization', 'completed', 'archived')),
	CONSTRAINT "user_jobs_arrays_check" CHECK (jsonb_typeof("user_jobs"."inputs") = 'array' AND jsonb_typeof("user_jobs"."results") = 'array' AND jsonb_typeof("user_jobs"."viewed_result_ids") = 'array' AND jsonb_typeof("user_jobs"."work"->'processedInputIds') = 'array')
);
--> statement-breakpoint
CREATE INDEX "user_jobs_owner_id_idx" ON "user_jobs" USING btree ("org_id","owner_user_id","id");--> statement-breakpoint
CREATE INDEX "user_jobs_runnable_owner_idx" ON "user_jobs" USING btree ("org_id","owner_user_id") WHERE "user_jobs"."status" <> 'archived' AND ("user_jobs"."status" = 'active' OR jsonb_array_length("user_jobs"."inputs") > jsonb_array_length("user_jobs"."work"->'processedInputIds'));