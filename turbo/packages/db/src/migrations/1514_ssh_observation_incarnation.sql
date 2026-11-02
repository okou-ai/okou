ALTER TABLE "ssh_connections" ADD CONSTRAINT "uq_ssh_connections_incarnation" UNIQUE("id","created_at");
--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD CONSTRAINT "ssh_observation_incarnation_fk" FOREIGN KEY ("connection_id","connection_created_at") REFERENCES "public"."ssh_connections"("id","created_at") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" VALIDATE CONSTRAINT "ssh_observation_incarnation_fk";
