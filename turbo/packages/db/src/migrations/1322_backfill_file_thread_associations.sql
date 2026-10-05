-- Preserve associations before request readers stop joining historical Runs.
-- Keyset batches cap each write set; the migration remains one atomic transaction.
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
DO $$
DECLARE
  cursor_id uuid;
  next_id uuid;
BEGIN
  LOOP
    SELECT page.id INTO next_id
    FROM (
      SELECT id
      FROM run_uploaded_files
      WHERE (cursor_id IS NULL OR id > cursor_id) AND run_id IS NOT NULL
      ORDER BY id
      LIMIT 1000
    ) page
    ORDER BY page.id DESC
    LIMIT 1;

    EXIT WHEN next_id IS NULL;

    UPDATE run_uploaded_files AS file
    SET chat_thread_id = COALESCE(file.chat_thread_id, run.chat_thread_id),
        org_id = COALESCE(file.org_id, run.org_id)
    FROM agent_runs AS run
    WHERE (cursor_id IS NULL OR file.id > cursor_id) AND file.id <= next_id
      AND file.run_id = run.id
      AND run.trigger_source IS NOT NULL
      AND (
        (file.chat_thread_id IS NULL AND run.chat_thread_id IS NOT NULL)
        OR file.org_id IS NULL
      );

    cursor_id := next_id;
  END LOOP;
END $$;
