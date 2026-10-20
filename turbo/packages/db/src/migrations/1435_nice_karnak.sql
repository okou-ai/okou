CREATE TABLE "desktop_shell_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"computer_use_host_id" uuid NOT NULL,
	"requested_by_run_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"request_expires_at" timestamp NOT NULL,
	"approved_at" timestamp,
	"grant_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_shell_authorization_status_check" CHECK ("desktop_shell_authorizations"."status" IN ('pending', 'approved', 'denied', 'revoked', 'expired')),
	CONSTRAINT "desktop_shell_authorization_deadline_check" CHECK (("desktop_shell_authorizations"."approved_at" IS NULL AND "desktop_shell_authorizations"."grant_expires_at" IS NULL AND "desktop_shell_authorizations"."status" IN ('pending', 'denied', 'expired')) OR ("desktop_shell_authorizations"."approved_at" IS NOT NULL AND "desktop_shell_authorizations"."grant_expires_at" IS NOT NULL AND "desktop_shell_authorizations"."grant_expires_at" = "desktop_shell_authorizations"."approved_at" + interval '1 hour' AND "desktop_shell_authorizations"."status" IN ('approved', 'revoked', 'expired')))
);
--> statement-breakpoint
ALTER TABLE "computer_use_commands" ADD COLUMN "shell_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "desktop_shell_authorizations" ADD CONSTRAINT "desktop_shell_authorizations_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_shell_authorizations" ADD CONSTRAINT "desktop_shell_authorizations_computer_use_host_id_computer_use_hosts_id_fk" FOREIGN KEY ("computer_use_host_id") REFERENCES "public"."computer_use_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_desktop_shell_authorization_run_host" ON "desktop_shell_authorizations" USING btree ("requested_by_run_id","computer_use_host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_desktop_shell_authorization_open_scope" ON "desktop_shell_authorizations" USING btree ("org_id","user_id","chat_thread_id","computer_use_host_id") WHERE "desktop_shell_authorizations"."status" IN ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "idx_desktop_shell_authorization_owner" ON "desktop_shell_authorizations" USING btree ("org_id","user_id");