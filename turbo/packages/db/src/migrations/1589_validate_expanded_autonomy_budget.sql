-- Validate after the constraint replacements release their ACCESS EXCLUSIVE locks.
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_autonomy_budget_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" VALIDATE CONSTRAINT "workflow_automations_autonomy_budget_check";
