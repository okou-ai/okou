CREATE TABLE "morning_brief_enrollments" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"membership_id" text,
	"source_created_at" timestamp,
	"state" text NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_enrollments_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "chk_morning_brief_enrollment_state" CHECK ("morning_brief_enrollments"."state" IN ('checking', 'pending', 'completed', 'cancelled', 'ineligible', 'departed'))
);
--> statement-breakpoint
CREATE TABLE "morning_brief_rollout" (
	"name" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp DEFAULT (now() AT TIME ZONE 'UTC') NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_morning_brief_enrollments_pending" ON "morning_brief_enrollments" USING btree ("available_at") WHERE "morning_brief_enrollments"."state" IN ('checking', 'pending');
--> statement-breakpoint
INSERT INTO "morning_brief_rollout" ("name") VALUES ('morning-brief');
