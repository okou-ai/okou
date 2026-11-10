-- Deploy the explicit receipt writer and drain preceding API invocations first.
-- Current writers already capture booleans, including concurrent queue inserts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "runner_job_queue"
    WHERE jsonb_typeof("execution_context") IS DISTINCT FROM 'object'
      OR (
        "execution_context" ? 'previewBypassAuthorized'
        AND jsonb_typeof("execution_context" -> 'previewBypassAuthorized') IS DISTINCT FROM 'boolean'
      )
      OR (
        NOT ("execution_context" ? 'previewBypassAuthorized')
        AND "execution_context" #> '{platformEnvironment,VERCEL_AUTOMATION_BYPASS_SECRET}' IS NOT NULL
        AND jsonb_typeof("execution_context" #> '{platformEnvironment,VERCEL_AUTOMATION_BYPASS_SECRET}') IS DISTINCT FROM 'string'
      )
  ) THEN
    RAISE EXCEPTION 'Invalid queued preview bypass authorization receipt';
  END IF;
END;
$$;
--> statement-breakpoint
UPDATE "runner_job_queue"
SET "execution_context" = jsonb_set(
  "execution_context",
  '{previewBypassAuthorized}',
  to_jsonb(COALESCE("execution_context" #>> '{platformEnvironment,VERCEL_AUTOMATION_BYPASS_SECRET}', '') <> '')
)
WHERE NOT ("execution_context" ? 'previewBypassAuthorized');
