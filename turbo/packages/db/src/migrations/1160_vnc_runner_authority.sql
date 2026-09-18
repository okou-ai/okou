CREATE TABLE "agent_vnc_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_vnc_access_owner_agent" UNIQUE("org_id","user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "vnc_control_leases" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"grant_id" uuid NOT NULL,
	"holder_id" uuid NOT NULL,
	"lease_token" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"heartbeat_generation" bigint NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "chk_vnc_control_leases_generation" CHECK ("vnc_control_leases"."generation" > 0),
	CONSTRAINT "chk_vnc_control_leases_runner_generation" CHECK ("vnc_control_leases"."heartbeat_generation" > 0 AND "vnc_control_leases"."heartbeat_generation" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD COLUMN "instance_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_vnc_access" ADD CONSTRAINT "agent_vnc_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vnc_control_leases" ADD CONSTRAINT "vnc_control_leases_connection_id_vnc_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."vnc_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_vnc_access_agent" ON "agent_vnc_access" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_vnc_access_user" ON "agent_vnc_access" USING btree ("user_id","id");