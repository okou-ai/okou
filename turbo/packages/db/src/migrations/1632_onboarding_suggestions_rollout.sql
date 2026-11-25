CREATE TABLE "onboarding_rollouts" (
	"name" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "onboarding_rollouts" ("name", "activated_at")
VALUES ('suggestions', date_trunc('milliseconds', statement_timestamp()));
