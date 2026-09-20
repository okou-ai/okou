-- Attachments are inputs the user handed to the agent, not artifacts.
--
-- `run_uploaded_files_queue_artifact_catalog` queues every stored file that
-- gains a URL, so once private storage started writing an ownership row for
-- each chat attachment, those attachments were registered as catalog artifacts
-- and appeared in the thread's Artifacts panel. The application now refuses to
-- register them; this removes the entries already written.
--
-- Only the catalog projection is removed. The files, their ownership records,
-- and the messages that carry them are untouched, and an attachment stays
-- readable through its own reference.
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
DO $$
DECLARE
  pending_count bigint;
  artifact_count bigint;
BEGIN
  WITH removed AS (
    DELETE FROM "artifact_catalog_pending_files" AS p
    USING "run_uploaded_files" AS f
    WHERE p."file_id" = f."id"
      AND (f."metadata" ->> 'purpose') IS DISTINCT FROM 'artifact'
      AND (
        f."classification" = 'input'
        OR (f."metadata" ->> 'storage' IS NOT NULL AND f."run_id" IS NULL)
      )
    RETURNING p."file_id"
  )
  SELECT count(*) INTO pending_count FROM removed;

  WITH removed AS (
    DELETE FROM "artifacts" AS a
    USING "run_uploaded_files" AS f
    WHERE a."projection_file_id" = f."id"
      AND (f."metadata" ->> 'purpose') IS DISTINCT FROM 'artifact'
      AND (
        f."classification" = 'input'
        OR (f."metadata" ->> 'storage' IS NOT NULL AND f."run_id" IS NULL)
      )
    RETURNING a."id"
  )
  SELECT count(*) INTO artifact_count FROM removed;

  RAISE NOTICE 'Dequeued % attachment file(s); removed % attachment catalog artifact(s)',
    pending_count, artifact_count;
END $$;
