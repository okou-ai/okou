CREATE TABLE "agentphone_connection_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"public_brand" text DEFAULT 'okou' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"consumed_phone_handle" varchar(254),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_agentphone_connection_codes_hash_expires" ON "agentphone_connection_codes" USING btree ("code_hash","expires_at");--> statement-breakpoint
CREATE INDEX "idx_agentphone_connection_codes_expires" ON "agentphone_connection_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agentphone_connection_codes_user_org" ON "agentphone_connection_codes" USING btree ("user_id","org_id");