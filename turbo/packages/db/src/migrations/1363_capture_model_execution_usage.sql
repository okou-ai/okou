ALTER TABLE "agent_runs" ADD COLUMN "model_usage_provider" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model_long_context_min_total_input_tokens" integer;