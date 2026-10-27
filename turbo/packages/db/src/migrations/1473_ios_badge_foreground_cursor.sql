ALTER TABLE "ios_push_registrations" ADD COLUMN "badge_cleared_at" timestamp;--> statement-breakpoint
ALTER TABLE "ios_push_registrations" ADD COLUMN "badge_cleared_revision" bigint;--> statement-breakpoint
ALTER TABLE "ios_push_registrations" ADD COLUMN "badge_clear_sequence" bigint;