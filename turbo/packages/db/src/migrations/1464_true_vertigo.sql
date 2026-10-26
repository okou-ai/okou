CREATE TABLE "ios_push_registrations" (
	"installation_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"device_token" text NOT NULL,
	"environment" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ios_push_registrations_user" ON "ios_push_registrations" USING btree ("user_id");