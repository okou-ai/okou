-- Permission refresh resolves current catalog entries by slug. The retired
-- derived baseline is not needed by either the old or new claim reader.
UPDATE "runner_job_queue"
SET "execution_context" = "execution_context" - 'connectorPermissionBaseline'
WHERE "execution_context" ? 'connectorPermissionBaseline';
