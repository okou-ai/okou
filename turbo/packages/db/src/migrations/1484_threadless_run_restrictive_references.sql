-- okou:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "agent_run_callbacks"
  DROP CONSTRAINT IF EXISTS "agent_run_callbacks_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "agent_run_callbacks_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "runner_job_queue"
  DROP CONSTRAINT IF EXISTS "runner_job_queue_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "runner_job_queue_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "usage_event"
  DROP CONSTRAINT IF EXISTS "usage_event_run_id_agent_runs_id_fk",
  ADD CONSTRAINT "usage_event_run_id_agent_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs" ("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
-- Merge the ordered FK/PK indexes instead of building a hash from cold tables.
-- One statement owns its planner settings, including through a pooled URL.
-- Avoid scanning the referenced index once for every parallel worker.
-- okou:batch-by-uuid
-- Read and check a bounded set before the full catalog validation. A fresh
-- compute must fetch these index/visibility pages without one cold 10s scan.
WITH batch AS MATERIALIZED (
  SELECT "id" AS id, "run_id" FROM "agent_run_callbacks"
  WHERE ($1::uuid IS NULL OR "id" > $1::uuid)
  ORDER BY "id" LIMIT 1000
), checked AS MATERIALIZED (
  SELECT count(batch."run_id") AS references, count(pk.id) AS matches
  FROM batch LEFT JOIN LATERAL (
    SELECT id FROM "agent_runs" WHERE id = batch."run_id" LIMIT 1
  ) pk ON true
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor,
  1 / CASE WHEN checked.references = checked.matches THEN 1 ELSE 0 END AS valid
FROM checked;
--> statement-breakpoint
DO $$ BEGIN
  SET LOCAL enable_seqscan = off;
  SET LOCAL enable_hashjoin = off;
  SET LOCAL enable_nestloop = off;
  SET LOCAL max_parallel_workers_per_gather = 0;
  ALTER TABLE "agent_run_callbacks"
    VALIDATE CONSTRAINT "agent_run_callbacks_run_id_agent_runs_id_fk";
END $$;
--> statement-breakpoint
-- okou:batch-by-uuid
-- Read and check a bounded set before the full catalog validation. A fresh
-- compute must fetch these index/visibility pages without one cold 10s scan.
WITH batch AS MATERIALIZED (
  SELECT "run_id" AS id, "run_id" FROM "runner_job_queue"
  WHERE ($1::uuid IS NULL OR "run_id" > $1::uuid)
  ORDER BY "run_id" LIMIT 1000
), checked AS MATERIALIZED (
  SELECT count(batch."run_id") AS references, count(pk.id) AS matches
  FROM batch LEFT JOIN LATERAL (
    SELECT id FROM "agent_runs" WHERE id = batch."run_id" LIMIT 1
  ) pk ON true
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor,
  1 / CASE WHEN checked.references = checked.matches THEN 1 ELSE 0 END AS valid
FROM checked;
--> statement-breakpoint
DO $$ BEGIN
  SET LOCAL enable_seqscan = off;
  SET LOCAL enable_hashjoin = off;
  SET LOCAL enable_nestloop = off;
  SET LOCAL max_parallel_workers_per_gather = 0;
  ALTER TABLE "runner_job_queue"
    VALIDATE CONSTRAINT "runner_job_queue_run_id_agent_runs_id_fk";
END $$;
--> statement-breakpoint
-- okou:batch-by-uuid
-- Read and check a bounded set before the full catalog validation. A fresh
-- compute must fetch these index/visibility pages without one cold 10s scan.
WITH batch AS MATERIALIZED (
  SELECT "id" AS id, "run_id" FROM "usage_event"
  WHERE ($1::uuid IS NULL OR "id" > $1::uuid)
  ORDER BY "id" LIMIT 1000
), checked AS MATERIALIZED (
  SELECT count(batch."run_id") AS references, count(pk.id) AS matches
  FROM batch LEFT JOIN LATERAL (
    SELECT id FROM "agent_runs" WHERE id = batch."run_id" LIMIT 1
  ) pk ON true
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor,
  1 / CASE WHEN checked.references = checked.matches THEN 1 ELSE 0 END AS valid
FROM checked;
--> statement-breakpoint
DO $$ BEGIN
  SET LOCAL enable_seqscan = off;
  SET LOCAL enable_hashjoin = off;
  SET LOCAL enable_nestloop = off;
  SET LOCAL max_parallel_workers_per_gather = 0;
  ALTER TABLE "usage_event"
    VALIDATE CONSTRAINT "usage_event_run_id_agent_runs_id_fk";
END $$;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
