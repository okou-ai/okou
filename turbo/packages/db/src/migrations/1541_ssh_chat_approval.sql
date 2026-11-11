CREATE TABLE "ssh_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"requested_by_run_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"callback_prompt" varchar(200) NOT NULL,
	"required_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"request_expires_at" timestamp NOT NULL,
	"continuation_queued_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_authorization_status_check" CHECK ("ssh_authorizations"."status" IN ('pending', 'approved', 'denied', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "ssh_authorizations" ADD CONSTRAINT "ssh_authorizations_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_authorizations" ADD CONSTRAINT "ssh_authorizations_connection_id_ssh_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ssh_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ssh_authorization_run_host_generation" ON "ssh_authorizations" USING btree ("requested_by_run_id","connection_id","generation");--> statement-breakpoint
CREATE INDEX "idx_ssh_authorization_owner" ON "ssh_authorizations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_ssh_authorization_thread" ON "ssh_authorizations" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_ssh_authorization_host" ON "ssh_authorizations" USING btree ("connection_id");