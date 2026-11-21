ALTER TABLE "workflows" DROP CONSTRAINT "workflows_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;