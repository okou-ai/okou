-- Explicitly approved pre-GA reset (#33468). Old host IDs, credentials and
-- learned identity/observations are discarded; Agent SSH grants are retained.
-- No data backfill or dual-storage compatibility is needed for this feature.
LOCK TABLE "ssh_connections" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DELETE FROM "ssh_connections";
--> statement-breakpoint
CREATE TABLE "ssh_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(128) NOT NULL,
	"username" varchar(255) NOT NULL,
	"auth_method" varchar(16) NOT NULL,
	"encrypted_private_key" text,
	"encrypted_passphrase" text,
	"encrypted_password" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ssh_credentials_owner_id" UNIQUE("id","org_id","user_id"),
	CONSTRAINT "chk_ssh_credentials_name" CHECK (char_length("ssh_credentials"."name") BETWEEN 1 AND 128),
	CONSTRAINT "chk_ssh_credentials_username" CHECK (char_length("ssh_credentials"."username") BETWEEN 1 AND 255),
	CONSTRAINT "chk_ssh_credentials_revision" CHECK ("ssh_credentials"."revision" > 0),
	CONSTRAINT "chk_ssh_credentials_auth" CHECK ((
    "ssh_credentials"."auth_method" = 'private_key' AND "ssh_credentials"."encrypted_private_key" IS NOT NULL
    AND char_length("ssh_credentials"."encrypted_private_key") > 0 AND "ssh_credentials"."encrypted_password" IS NULL
    AND ("ssh_credentials"."encrypted_passphrase" IS NULL OR char_length("ssh_credentials"."encrypted_passphrase") > 0)
  ) OR (
    "ssh_credentials"."auth_method" = 'password' AND "ssh_credentials"."encrypted_password" IS NOT NULL
    AND char_length("ssh_credentials"."encrypted_password") > 0
    AND "ssh_credentials"."encrypted_private_key" IS NULL AND "ssh_credentials"."encrypted_passphrase" IS NULL
  ))
);
--> statement-breakpoint
ALTER TABLE "ssh_connection_credentials" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ssh_connection_credentials";--> statement-breakpoint
ALTER TABLE "ssh_connections" DROP CONSTRAINT "chk_ssh_connections_username";--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD COLUMN "credential_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ssh_credentials_owner_created" ON "ssh_credentials" USING btree ("org_id","user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "ssh_connections" ADD CONSTRAINT "ssh_connections_credential_owner_fk" FOREIGN KEY ("credential_id","org_id","user_id") REFERENCES "public"."ssh_credentials"("id","org_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ssh_connections_credential" ON "ssh_connections" USING btree ("credential_id","id");--> statement-breakpoint
ALTER TABLE "ssh_connections" DROP COLUMN "username";
