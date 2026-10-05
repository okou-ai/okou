ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_autonomy_budget_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_autonomy_budget_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" ALTER COLUMN "autonomy_budget" SET DEFAULT 32;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_autonomy_budget_check" CHECK ("agent_runs"."autonomy_budget" >= 0 AND "agent_runs"."autonomy_budget" <= 32);--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_autonomy_budget_check" CHECK ("workflow_automations"."autonomy_budget" BETWEEN 0 AND 32);