ALTER TABLE "chat_threads" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "uq_agents_id_org" UNIQUE("id","org_id");--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_agent_org_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE no action ON UPDATE no action;
