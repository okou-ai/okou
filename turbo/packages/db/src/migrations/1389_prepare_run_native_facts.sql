ALTER TABLE "agent_runs" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "framework" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "framework_session_id" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "legacy_conversation_history_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;