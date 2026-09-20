CREATE TABLE "connector_account_oauth_bindings" (
	"connector_account_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_slug" varchar(64) NOT NULL,
	"auth_method" varchar(50) NOT NULL,
	"storage_version" bigint NOT NULL,
	"contract_hash" varchar(64) NOT NULL,
	"endpoint" text NOT NULL,
	"issuer" text NOT NULL,
	"resource" text NOT NULL,
	"resource_metadata_url" text,
	"token_endpoint" text NOT NULL,
	"client_id" text NOT NULL,
	"token_endpoint_auth_method" varchar(32) NOT NULL,
	"registration_method" varchar(8) NOT NULL,
	"dcr_registration_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_connector_oauth_binding_identity" CHECK ("connector_account_oauth_bindings"."storage_version" > 0 AND "connector_account_oauth_bindings"."contract_hash" ~ '^[a-f0-9]{64}$' AND btrim("connector_account_oauth_bindings"."endpoint") <> '' AND btrim("connector_account_oauth_bindings"."issuer") <> '' AND btrim("connector_account_oauth_bindings"."resource") <> '' AND btrim("connector_account_oauth_bindings"."token_endpoint") <> '' AND btrim("connector_account_oauth_bindings"."client_id") <> ''),
	CONSTRAINT "chk_connector_oauth_binding_token_auth" CHECK ("connector_account_oauth_bindings"."token_endpoint_auth_method" IN ('none', 'client_secret_basic', 'client_secret_post')),
	CONSTRAINT "chk_connector_oauth_binding_registration" CHECK (("connector_account_oauth_bindings"."registration_method" = 'cimd' AND "connector_account_oauth_bindings"."dcr_registration_id" IS NULL AND "connector_account_oauth_bindings"."token_endpoint_auth_method" = 'none') OR ("connector_account_oauth_bindings"."registration_method" = 'dcr' AND "connector_account_oauth_bindings"."dcr_registration_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "connector_dcr_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"connector_slug" varchar(64) NOT NULL,
	"auth_method" varchar(50) NOT NULL,
	"contract_hash" varchar(64) NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text,
	"token_endpoint_auth_method" varchar(32) NOT NULL,
	"registered_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"redirect_uri" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_connector_dcr_owner" UNIQUE("id","org_id","connector_slug","auth_method","contract_hash"),
	CONSTRAINT "uq_connector_dcr_issuer" UNIQUE("org_id","connector_slug","auth_method","contract_hash","issuer"),
	CONSTRAINT "chk_connector_dcr_identity" CHECK (btrim("connector_dcr_registrations"."issuer") <> '' AND btrim("connector_dcr_registrations"."client_id") <> '' AND btrim("connector_dcr_registrations"."redirect_uri") <> '' AND "connector_dcr_registrations"."contract_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chk_connector_dcr_client_auth" CHECK (("connector_dcr_registrations"."token_endpoint_auth_method" = 'none' AND "connector_dcr_registrations"."encrypted_client_secret" IS NULL) OR ("connector_dcr_registrations"."token_endpoint_auth_method" IN ('client_secret_basic', 'client_secret_post') AND "connector_dcr_registrations"."encrypted_client_secret" IS NOT NULL)),
	CONSTRAINT "chk_connector_dcr_expiry" CHECK ("connector_dcr_registrations"."expires_at" IS NULL OR "connector_dcr_registrations"."expires_at" > "connector_dcr_registrations"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "automatic_auth_type" varchar(8);--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" ADD CONSTRAINT "fk_connector_oauth_binding_account" FOREIGN KEY ("connector_account_id","connector_slug") REFERENCES "public"."connectors"("id","connector_slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" ADD CONSTRAINT "fk_connector_oauth_binding_account_owner" FOREIGN KEY ("connector_account_id","org_id","user_id") REFERENCES "public"."connectors"("id","org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_account_oauth_bindings" ADD CONSTRAINT "fk_connector_oauth_binding_dcr_owner" FOREIGN KEY ("dcr_registration_id","org_id","connector_slug","auth_method","contract_hash") REFERENCES "public"."connector_dcr_registrations"("id","org_id","connector_slug","auth_method","contract_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_binding_dcr" ON "connector_account_oauth_bindings" USING btree ("dcr_registration_id");--> statement-breakpoint
CREATE INDEX "idx_connector_dcr_org" ON "connector_dcr_registrations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_automatic_auth_type" CHECK ("connectors"."automatic_auth_type" IS NULL OR (
          "connectors"."connector_slug" IS NOT NULL
          AND "connectors"."automatic_auth_type" IN ('none', 'oauth')
          AND ("connectors"."automatic_auth_type" <> 'none' OR "connectors"."token_expires_at" IS NULL)
        ));