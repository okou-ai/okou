CREATE TABLE "vnc_connection_observations" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"connection_created_at" timestamp NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"failure_reason" varchar(64),
	"ssh_generation" integer,
	"kdc_ssh_generation" integer,
	CONSTRAINT "chk_vnc_observation_ssh_generation" CHECK ("vnc_connection_observations"."ssh_generation" IS NULL OR "vnc_connection_observations"."ssh_generation" > 0),
	CONSTRAINT "chk_vnc_observation_kdc_ssh_generation" CHECK ("vnc_connection_observations"."kdc_ssh_generation" IS NULL OR "vnc_connection_observations"."kdc_ssh_generation" > 0),
	CONSTRAINT "chk_vnc_connection_observation_generation" CHECK ("vnc_connection_observations"."generation" > 0),
	CONSTRAINT "chk_vnc_connection_observation_failure" CHECK ("vnc_connection_observations"."failure_reason" IS NULL OR "vnc_connection_observations"."failure_reason" IN ('invalid_credential', 'unsafe_destination', 'network_failure', 'protocol', 'timed_out', 'disconnected', 'authentication_failed', 'unsupported_profile', 'kerberos_expired', 'kerberos_non_renewable', 'kerberos_renewal_exhausted'))
);
--> statement-breakpoint
ALTER TABLE "vnc_connection_observations" ADD CONSTRAINT "vnc_connection_observations_connection_id_vnc_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."vnc_connections"("id") ON DELETE cascade ON UPDATE no action;