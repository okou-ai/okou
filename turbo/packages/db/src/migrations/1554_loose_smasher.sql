CREATE TABLE "phone_use_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"display_name" text NOT NULL,
	"os_version" text NOT NULL,
	"app_version" text NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_use_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_generation" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_use_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claimed_generation" integer,
	"result" jsonb,
	"error" text,
	"screenshot_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "phone_use_grants" ADD CONSTRAINT "phone_use_grants_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_use_grants" ADD CONSTRAINT "phone_use_grants_device_id_phone_use_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."phone_use_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_use_operations" ADD CONSTRAINT "phone_use_operations_device_id_phone_use_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."phone_use_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_use_device_installation" ON "phone_use_devices" USING btree ("org_id","user_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_use_grant_chat_owner" ON "phone_use_grants" USING btree ("org_id","user_id","thread_id");--> statement-breakpoint
CREATE INDEX "phone_use_operations_device_status" ON "phone_use_operations" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_use_running_operation" ON "phone_use_operations" USING btree ("device_id") WHERE status = 'running';