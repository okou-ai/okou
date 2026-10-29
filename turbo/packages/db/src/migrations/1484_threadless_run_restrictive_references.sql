-- okou:non-transactional
-- Keep the migrator's existing 1s/10s DDL defaults outside TX-0357.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- Replace the action atomically; every committed prefix retains a Run FK.
ALTER TABLE "agent_run_callbacks"
  DROP CONSTRAINT IF EXISTS "agent_run_callbacks_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "agent_run_callbacks_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
-- Replace the action atomically; every committed prefix retains a Run FK.
ALTER TABLE "runner_job_queue"
  DROP CONSTRAINT IF EXISTS "runner_job_queue_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "runner_job_queue_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
-- Replace the action atomically; every committed prefix retains a Run FK.
ALTER TABLE "usage_event"
  DROP CONSTRAINT IF EXISTS "usage_event_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "usage_event_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_run_callbacks"
  VALIDATE CONSTRAINT "agent_run_callbacks_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "runner_job_queue"
  VALIDATE CONSTRAINT "runner_job_queue_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_event"
  VALIDATE CONSTRAINT "usage_event_run_id_agent_runs_id_fk";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
