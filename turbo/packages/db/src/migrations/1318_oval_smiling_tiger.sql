CREATE TABLE "tailscale_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"scope" text DEFAULT 'personal' NOT NULL,
	"name" varchar(128) NOT NULL,
	"encrypted_client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"tags" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_tailscale_configs_org_id" UNIQUE("id","org_id"),
	CONSTRAINT "chk_tailscale_configs_name" CHECK (char_length("tailscale_configs"."name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_tailscale_configs_revision" CHECK ("tailscale_configs"."revision" > 0 AND "tailscale_configs"."generation" > 0),
	CONSTRAINT "chk_tailscale_configs_credentials" CHECK (char_length("tailscale_configs"."encrypted_client_id") > 0 AND char_length("tailscale_configs"."encrypted_client_secret") > 0),
	CONSTRAINT "chk_tailscale_configs_scope_owner" CHECK (("tailscale_configs"."scope" = 'personal' AND "tailscale_configs"."user_id" IS NOT NULL) OR ("tailscale_configs"."scope" = 'organization' AND "tailscale_configs"."user_id" IS NULL)),
	CONSTRAINT "chk_tailscale_configs_tags" CHECK (array_ndims("tailscale_configs"."tags") = 1 AND cardinality("tailscale_configs"."tags") BETWEEN 1 AND 16 AND array_position("tailscale_configs"."tags", NULL) IS NULL)
);
--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD COLUMN "tailscale_config_id" uuid;--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD COLUMN "tailscale_config_generation" integer;--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "tailscale_config_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_tailscale_configs_owner_created" ON "tailscale_configs" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_tailscale_org_fk" FOREIGN KEY ("tailscale_config_id","org_id") REFERENCES "public"."tailscale_configs"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ssh_connections_tailscale" ON "ssh_connections" USING btree ("tailscale_config_id","id");--> statement-breakpoint
ALTER TABLE "ssh_connection_observations" ADD CONSTRAINT "chk_ssh_connection_observation_tailscale_pair" CHECK (("ssh_connection_observations"."tailscale_config_id" IS NULL) = ("ssh_connection_observations"."tailscale_config_generation" IS NULL) AND ("ssh_connection_observations"."tailscale_config_generation" IS NULL OR "ssh_connection_observations"."tailscale_config_generation" > 0));--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "chk_ssh_connections_tailscale_exclusive" CHECK ("ssh_connections"."tailscale_config_id" IS NULL OR ("ssh_connections"."cloudflare_access_id" IS NULL AND NOT "ssh_connections"."needs_rebind"));