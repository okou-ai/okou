CREATE TABLE "email_connection_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"consumed_email" text,
	"consumed_provider_email_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_connection_codes_member_idx" ON "email_connection_codes" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "email_connection_codes_expires_idx" ON "email_connection_codes" USING btree ("expires_at");