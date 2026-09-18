CREATE TABLE "agent_vnc_access" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_vnc_access_pkey" PRIMARY KEY("org_id","user_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_vnc_access" ADD CONSTRAINT "agent_vnc_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_vnc_access_agent" ON "agent_vnc_access" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_vnc_access_user" ON "agent_vnc_access" USING btree ("user_id");