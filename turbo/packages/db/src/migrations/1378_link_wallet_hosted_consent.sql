CREATE TABLE "link_wallet_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"encrypted_credentials" text,
	"revoked_at" timestamp with time zone,
	"revocation_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_wallet_oauth_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_wallet_spends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"provider_spend_id" varchar(256),
	"amount" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_url" text NOT NULL,
	"context" text NOT NULL,
	"test" boolean NOT NULL,
	"status" varchar(32) DEFAULT 'creating' NOT NULL,
	"approval_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link_wallet_connections" ADD CONSTRAINT "link_wallet_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_wallet_oauth_attempts" ADD CONSTRAINT "link_wallet_oauth_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_wallet_spends" ADD CONSTRAINT "link_wallet_spends_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_wallet_spends" ADD CONSTRAINT "link_wallet_spends_connection_id_link_wallet_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."link_wallet_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_connections_owner_agent" ON "link_wallet_connections" USING btree ("org_id","user_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_oauth_state" ON "link_wallet_oauth_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "idx_link_wallet_oauth_expiry" ON "link_wallet_oauth_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_spends_intent" ON "link_wallet_spends" USING btree ("org_id","user_id","agent_id","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_spends_provider" ON "link_wallet_spends" USING btree ("provider_spend_id");