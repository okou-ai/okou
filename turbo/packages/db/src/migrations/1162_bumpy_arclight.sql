ALTER TABLE "morning_brief_generations" DROP CONSTRAINT "chk_morning_brief_generation_decision";--> statement-breakpoint
ALTER TABLE "morning_brief_generations" ADD COLUMN "content_purged_at" timestamp;--> statement-breakpoint
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