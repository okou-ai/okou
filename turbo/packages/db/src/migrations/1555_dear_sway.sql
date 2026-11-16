CREATE TABLE "agent_run_phase_timings" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"research_started_at" timestamp,
	"generation_started_at" timestamp,
	"research_skipped" boolean DEFAULT false NOT NULL,
	"generation_kind" text,
	CONSTRAINT "agent_run_phase_timings_version" CHECK ("agent_run_phase_timings"."schema_version" = 1),
	CONSTRAINT "agent_run_phase_timings_nonempty" CHECK ("agent_run_phase_timings"."research_started_at" IS NOT NULL OR "agent_run_phase_timings"."generation_started_at" IS NOT NULL),
	CONSTRAINT "agent_run_phase_timings_order" CHECK ("agent_run_phase_timings"."research_started_at" IS NULL OR "agent_run_phase_timings"."generation_started_at" IS NULL OR "agent_run_phase_timings"."research_started_at" <= "agent_run_phase_timings"."generation_started_at"),
	CONSTRAINT "agent_run_phase_timings_skip" CHECK (NOT "agent_run_phase_timings"."research_skipped" OR ("agent_run_phase_timings"."research_started_at" IS NULL AND "agent_run_phase_timings"."generation_started_at" IS NOT NULL)),
	CONSTRAINT "agent_run_phase_timings_kind" CHECK (("agent_run_phase_timings"."generation_started_at" IS NULL AND "agent_run_phase_timings"."generation_kind" IS NULL) OR ("agent_run_phase_timings"."generation_started_at" IS NOT NULL AND "agent_run_phase_timings"."generation_kind" IS NOT NULL AND "agent_run_phase_timings"."generation_kind" IN ('image', 'presentation', 'document', 'spreadsheet', 'website', 'report', 'video', 'audio', 'mixed', 'other')))
);
--> statement-breakpoint
ALTER TABLE "agent_run_phase_timings" ADD CONSTRAINT "agent_run_phase_timings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;