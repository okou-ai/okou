-- okou:non-transactional
-- Enforce new writes immediately, then scan existing rows without an ACCESS
-- EXCLUSIVE lock. The old validated constraint remains until atomic contraction.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_runs'::regclass
      AND conname = 'agent_runs_metadata_without_goal_check') THEN
    ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_metadata_without_goal_check" CHECK ((
          (
            "agent_runs"."trigger_source" IS NULL AND
            "agent_runs"."autonomy_budget" IS NULL AND
            "agent_runs"."workflow_automation_id" IS NULL AND
            "agent_runs"."model_provider" IS NULL AND
            "agent_runs"."model_provider_id" IS NULL AND
            "agent_runs"."model_provider_credential_scope" IS NULL AND
            "agent_runs"."selected_model" IS NULL AND
            "agent_runs"."model_runtime_provider" IS NULL AND
            "agent_runs"."model_runtime_model" IS NULL AND
            "agent_runs"."built_in_model_key_id" IS NULL AND
            "agent_runs"."codex_service_tier" IS NULL AND
            "agent_runs"."selected_video_model" IS NULL AND
            "agent_runs"."selected_image_model" IS NULL AND
            "agent_runs"."chat_thread_id" IS NULL AND
            "agent_runs"."api_started_at" IS NULL AND
            "agent_runs"."first_assistant_event_acknowledged_at" IS NULL AND
            "agent_runs"."summary" IS NULL AND
            "agent_runs"."trigger_brief" IS NULL
          ) OR (
            "agent_runs"."trigger_source" IS NOT NULL AND
            "agent_runs"."autonomy_budget" IS NOT NULL
          )
        )) NOT VALID;
  END IF;
END;
$$;
--> statement-breakpoint
SET statement_timeout = '60s';
--> statement-breakpoint
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_metadata_without_goal_check;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
