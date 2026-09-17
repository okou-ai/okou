ALTER TABLE "agent_runs" ADD COLUMN "runner_cancellation_mode" text;--> statement-breakpoint
-- Existing rows receive NULL; enforce new writes without scanning those rows.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_runner_cancellation_mode_check" CHECK ("agent_runs"."runner_cancellation_mode" IN ('cooperative', 'hard')) NOT VALID;
