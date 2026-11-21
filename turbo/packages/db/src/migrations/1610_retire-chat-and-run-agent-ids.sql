DROP FUNCTION public.delete_agent_rows(uuid, text, text, boolean);
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_agent_org_fk";
--> statement-breakpoint
DROP INDEX "idx_agent_runs_agent";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_agent_pinned";--> statement-breakpoint
DROP INDEX "idx_chat_threads_user_agent_last_message";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "agent_id";