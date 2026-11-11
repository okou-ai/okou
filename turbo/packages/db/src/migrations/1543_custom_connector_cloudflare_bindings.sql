CREATE TABLE "org_custom_connector_cloudflare_bindings" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"config_id" uuid NOT NULL,
	"config_scope" text DEFAULT 'organization' NOT NULL,
	CONSTRAINT "chk_custom_connector_cloudflare_scope" CHECK ("org_custom_connector_cloudflare_bindings"."config_scope" = 'organization')
);
--> statement-breakpoint
ALTER TABLE "org_custom_connector_cloudflare_bindings" ADD CONSTRAINT "fk_custom_connector_cloudflare_connector" FOREIGN KEY ("connector_id","org_id") REFERENCES "public"."org_custom_connectors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_connector_cloudflare_bindings" ADD CONSTRAINT "fk_custom_connector_cloudflare_config" FOREIGN KEY ("config_id","org_id","config_scope") REFERENCES "public"."cloudflare_access_configs"("id","org_id","scope") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "idx_custom_connector_cloudflare_config" ON "org_custom_connector_cloudflare_bindings" USING btree ("config_id","org_id");