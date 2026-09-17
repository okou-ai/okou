-- The preceding expand transaction commits before this bounded validation scan.
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_launch_snapshot_check";
