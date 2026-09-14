CREATE TABLE "cloudflare_access_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"encrypted_client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_cloudflare_access_configs_owner_id" UNIQUE("id","org_id","user_id"),
	CONSTRAINT "chk_cloudflare_access_configs_name" CHECK (char_length("cloudflare_access_configs"."name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_cloudflare_access_configs_revision" CHECK ("cloudflare_access_configs"."revision" > 0 AND "cloudflare_access_configs"."generation" > 0),
	CONSTRAINT "chk_cloudflare_access_configs_credentials" CHECK (char_length("cloudflare_access_configs"."encrypted_client_id") > 0 AND char_length("cloudflare_access_configs"."encrypted_client_secret") > 0)
);
--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" DROP CONSTRAINT "chk_ssh_connection_observation_failure";--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "cloudflare_access_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_cloudflare_access_configs_owner_created" ON "cloudflare_access_configs" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_cloudflare_access_owner_fk" FOREIGN KEY ("cloudflare_access_id","org_id","user_id") REFERENCES "public"."cloudflare_access_configs"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ssh_connections_cloudflare_access" ON "ssh_connections" USING btree ("cloudflare_access_id","id");--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD CONSTRAINT "chk_ssh_connection_observation_failure" CHECK ("ssh_connection_observations"."failure_reason" IS NULL OR "ssh_connection_observations"."failure_reason" IN ('invalid_credential', 'unsupported_credential', 'credential_resource_limit', 'unsafe_destination', 'network_failure', 'host_key_mismatch', 'unsupported_host_key', 'authentication_failed', 'protocol', 'timed_out', 'access_rejected', 'access_tls_failure', 'access_protocol_failure'));--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "chk_ssh_connections_cloudflare_access_destination" CHECK ("ssh_connections"."cloudflare_access_id" IS NULL OR ("ssh_connections"."port" = 443 AND "ssh_connections"."host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' AND "ssh_connections"."host" !~ '^[0-9.]+$'));