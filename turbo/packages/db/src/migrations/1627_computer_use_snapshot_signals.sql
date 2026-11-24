-- A previous PR preview already applied these nullable columns before the migration was renumbered.
ALTER TABLE "computer_use_commands" ADD COLUMN IF NOT EXISTS "snapshot_offer" text;--> statement-breakpoint
ALTER TABLE "computer_use_commands" ADD COLUMN IF NOT EXISTS "snapshot_answer" text;
