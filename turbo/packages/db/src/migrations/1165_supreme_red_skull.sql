ALTER TABLE "morning_brief_generations" DROP CONSTRAINT "chk_morning_brief_generation_language_source";--> statement-breakpoint
ALTER TABLE "morning_brief_generations" DROP CONSTRAINT "chk_morning_brief_generation_decision";--> statement-breakpoint
ALTER TABLE "morning_brief_collection_occurrences" ALTER COLUMN "slack_workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "morning_brief_collection_occurrences" ALTER COLUMN "slack_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "instructions_version_id" text;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "instructions_digest" text;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "reported_language" text;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "retained_sources" jsonb;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "retained_until" timestamp;--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "content_purged_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_morning_brief_generations_invoked_anchor" ON "morning_brief_generations" USING btree ("org_id","user_id","scheduled_for","execution_purpose") WHERE "morning_brief_generations"."state" NOT IN ('not_invoked', 'skipped_empty', 'skipped_incomplete');--> statement-breakpoint
ALTER TABLE "morning_brief_collection_occurrences" ADD CONSTRAINT "chk_morning_brief_collection_occurrence_slack_binding" CHECK (("morning_brief_collection_occurrences"."collection_kind" = 'slack') =
          ("morning_brief_collection_occurrences"."slack_workspace_id" IS NOT NULL AND "morning_brief_collection_occurrences"."slack_user_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_retained_until" CHECK ("morning_brief_generations"."retained_until" IS NULL
          OR "morning_brief_generations"."retained_until" >= "morning_brief_generations"."expires_at");--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_instructions" CHECK (("morning_brief_generations"."instructions_version_id" IS NULL) =
          ("morning_brief_generations"."instructions_digest" IS NULL));--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_language_source" CHECK ("morning_brief_generations"."language_source" IN ('agent-instructions', 'member-locale', 'default'));--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD CONSTRAINT "chk_morning_brief_generation_decision" CHECK (("morning_brief_generations"."state" = 'succeeded') = ("morning_brief_generations"."decision" IS NOT NULL)
          AND ("morning_brief_generations"."decision" = 'deliver') =
            (("morning_brief_generations"."result_markdown" IS NOT NULL
              AND "morning_brief_generations"."result_title" IS NOT NULL
              AND "morning_brief_generations"."result_bytes" IS NOT NULL)
             OR ("morning_brief_generations"."content_purged_at" IS NOT NULL
              AND "morning_brief_generations"."result_markdown" IS NULL
              AND "morning_brief_generations"."result_title" IS NULL
              AND "morning_brief_generations"."result_bytes" IS NULL))
          AND ("morning_brief_generations"."content_purged_at" IS NULL
            OR ("morning_brief_generations"."state" = 'succeeded' AND "morning_brief_generations"."decision" = 'deliver'))
          AND ("morning_brief_generations"."result_bytes" IS NULL OR "morning_brief_generations"."result_bytes" > 0));