-- vm0:non-transactional
-- Heartbeat updates rewrote both heartbeat indexes on every write, and no query
-- uses them: active-run scans filter by status only. Build the status-only
-- index first so those scans never lose index support, then drop the heartbeat
-- indexes so heartbeat updates can stay HOT. CONCURRENTLY does not block run
-- writes but waits for older transactions on agent_runs.
SET lock_timeout = '10min';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
-- Recover an invalid index left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_status";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agent_runs_status" ON "agent_runs" USING btree ("status");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_status_heartbeat";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_running_heartbeat";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
