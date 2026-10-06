-- Serialize the association check with the constraint drop's file writes.
-- Keep the migration runner's normal 1s lock and 10s statement timeouts.
LOCK TABLE "run_uploaded_files" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "run_uploaded_files" AS file
    JOIN "agent_runs" AS run ON run.id = file.run_id
    WHERE run.trigger_source IS NOT NULL
      AND run.chat_thread_id IS NOT NULL
      AND (file.chat_thread_id IS NULL OR file.org_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Reconcile run-backed file thread/org associations before detaching Run provenance';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "run_uploaded_files" DROP CONSTRAINT "run_uploaded_files_run_id_agent_runs_id_fk";
