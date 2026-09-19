CREATE TABLE "agent_run_api_usage" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"projection" jsonb NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "agent_run_api_usage_revision_check" CHECK ("agent_run_api_usage"."revision" >= 1),
	CONSTRAINT "agent_run_api_usage_projection_check" CHECK (jsonb_typeof("agent_run_api_usage"."projection") = 'object' AND "agent_run_api_usage"."projection"->'schemaVersion' = '1'::jsonb AND jsonb_typeof("agent_run_api_usage"."projection"->'attempts') = 'array' AND jsonb_array_length("agent_run_api_usage"."projection"->'attempts') <= 8),
	CONSTRAINT "agent_run_api_usage_size_check" CHECK (octet_length("agent_run_api_usage"."projection"::text) <= 32768)
);
--> statement-breakpoint
ALTER TABLE "agent_run_api_usage" ADD CONSTRAINT "agent_run_api_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;