-- Fill the gap left by pre-#36900 API instances during the first rollout.
-- A started terminal run can still own a runner while it is finishing: retain
-- it through the 120-second recovery window, or while it still heartbeats.
-- Completed cancellation recovery proves the runner already reported back.
INSERT INTO "active_agent_runs" ("run_id", "org_id", "user_id", "chat_thread_id", "last_heartbeat_at")
SELECT "id", "org_id", "user_id", "chat_thread_id", COALESCE("last_heartbeat_at", "created_at")
FROM "agent_runs"
WHERE "status" IN ('queued', 'pending', 'running')
   OR (
     "started_at" IS NOT NULL
     AND "status" NOT IN ('queued', 'pending', 'running')
     AND "completed_at" IS NOT NULL
     AND ("status" <> 'cancelled' OR "cancellation_recovery_completed" IS DISTINCT FROM TRUE)
     AND (
       "completed_at" > (statement_timestamp() AT TIME ZONE 'UTC') - INTERVAL '120 seconds'
       OR "last_heartbeat_at" > (statement_timestamp() AT TIME ZONE 'UTC') - INTERVAL '120 seconds'
     )
   )
ON CONFLICT ("run_id") DO NOTHING;--> statement-breakpoint
-- Match the stale-terminal sweep: both completion and heartbeat must be old.
-- In particular, a cancelled run still heartbeating keeps its active row.
DELETE FROM "active_agent_runs" AS "active"
USING "agent_runs" AS "run"
WHERE "run"."id" = "active"."run_id"
  AND "run"."status" NOT IN ('queued', 'pending', 'running')
  AND "run"."completed_at" < (statement_timestamp() AT TIME ZONE 'UTC') - INTERVAL '120 seconds'
  AND "active"."last_heartbeat_at" < (statement_timestamp() AT TIME ZONE 'UTC') - INTERVAL '120 seconds';--> statement-breakpoint
DROP TABLE "run_activity_snapshots";
