ALTER TABLE "runner_state" ADD COLUMN "held_home_states" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "home_affinity_version" integer;--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "home_affinity_generation" bigint;--> statement-breakpoint
ALTER TABLE "runner_state" ADD COLUMN "home_affinity_sequence" bigint;