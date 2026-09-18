CREATE TABLE "vnc_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"host" varchar(253) NOT NULL,
	"port" integer DEFAULT 5900 NOT NULL,
	"credential_id" uuid NOT NULL,
	"security_type" varchar(32) NOT NULL,
	"trust_mode" varchar(16) NOT NULL,
	"ca_bundle" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_vnc_connections_display_name" CHECK (char_length("vnc_connections"."display_name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_vnc_connections_host" CHECK (char_length("vnc_connections"."host") BETWEEN 1 AND 253 AND "vnc_connections"."host" = lower("vnc_connections"."host") AND "vnc_connections"."host" !~ '[[:space:]/@?#]'),
	CONSTRAINT "chk_vnc_connections_port" CHECK ("vnc_connections"."port" BETWEEN 1 AND 65535),
	CONSTRAINT "chk_vnc_connections_generation" CHECK ("vnc_connections"."generation" > 0),
	CONSTRAINT "chk_vnc_connections_security_type" CHECK ("vnc_connections"."security_type" = 'x509_vnc'),
	CONSTRAINT "chk_vnc_connections_trust" CHECK (("vnc_connections"."trust_mode" = 'system' AND "vnc_connections"."ca_bundle" IS NULL) OR ("vnc_connections"."trust_mode" = 'custom_ca' AND "vnc_connections"."ca_bundle" IS NOT NULL AND octet_length("vnc_connections"."ca_bundle") BETWEEN 1 AND 65536))
);
--> statement-breakpoint
CREATE TABLE "vnc_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"auth_method" varchar(32) NOT NULL,
	"encrypted_password" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_vnc_credentials_owner_id" UNIQUE("id","org_id","user_id"),
	CONSTRAINT "chk_vnc_credentials_name" CHECK (char_length("vnc_credentials"."name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_vnc_credentials_auth_method" CHECK ("vnc_credentials"."auth_method" = 'vnc_password'),
	CONSTRAINT "chk_vnc_credentials_password" CHECK (char_length("vnc_credentials"."encrypted_password") > 0),
	CONSTRAINT "chk_vnc_credentials_revision" CHECK ("vnc_credentials"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "vnc_connections" ADD CONSTRAINT "vnc_connections_credential_owner_fk" FOREIGN KEY ("credential_id","org_id","user_id") REFERENCES "public"."vnc_credentials"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_credential" ON "vnc_connections" USING btree ("credential_id","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_owner_created" ON "vnc_connections" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_connections_user" ON "vnc_connections" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_credentials_owner_created" ON "vnc_credentials" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_vnc_credentials_user" ON "vnc_credentials" USING btree ("user_id","id");