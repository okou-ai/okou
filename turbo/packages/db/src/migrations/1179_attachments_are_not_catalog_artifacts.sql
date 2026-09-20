-- Attachments are inputs the user handed to the agent, not artifacts.
--
-- `run_uploaded_files_queue_artifact_catalog` queues every stored file that
-- gains a URL, and every chat or integration attachment gains one: a private
-- upload through its ownership record, a public upload when the send registers
-- its canonical input asset. Those attachments were therefore registered as
-- catalog artifacts and appeared in the thread's Artifacts panel. The
-- application now refuses to register them; this removes the entries already
-- written.
--
-- Scope is deliberately `classification = 'input'`, the marker the send writes
-- on every attachment. A private ownership record that was never attached to a
-- message carries no marker distinguishing an abandoned composer upload from a
-- run-less generated artifact, so those rows keep their catalog entry rather
-- than risk deleting a generation the user paid for.
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
      AND f."classification" = 'input'
      AND (f."metadata" ->> 'purpose') IS DISTINCT FROM 'artifact'
    RETURNING p."file_id"
  )
  SELECT count(*) INTO pending_count FROM removed;

  WITH removed AS (
    DELETE FROM "artifacts" AS a
    USING "run_uploaded_files" AS f
    WHERE a."projection_file_id" = f."id"
      AND f."classification" = 'input'
      AND (f."metadata" ->> 'purpose') IS DISTINCT FROM 'artifact'
    RETURNING a."id"
  )
  SELECT count(*) INTO artifact_count FROM removed;

  RAISE NOTICE 'Dequeued % attachment file(s); removed % attachment catalog artifact(s)',
    pending_count, artifact_count;
END $$;
