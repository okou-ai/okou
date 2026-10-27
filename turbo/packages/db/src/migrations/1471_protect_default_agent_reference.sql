ALTER TABLE "org_metadata" DROP CONSTRAINT "org_metadata_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "org_metadata" ADD CONSTRAINT "org_metadata_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_metadata" VALIDATE CONSTRAINT "org_metadata_default_agent_id_agents_id_fk";
