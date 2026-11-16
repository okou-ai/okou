ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_type";--> statement-breakpoint
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_suggestion_state";--> statement-breakpoint
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_suggestion_content";--> statement-breakpoint
ALTER TABLE "feed_items" DROP CONSTRAINT "feed_items_suggestion_expiry";--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "source_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
CREATE INDEX "feed_items_active_events" ON "feed_items" USING btree ("org_id","user_id","priority" DESC NULLS LAST,"created_at","id") WHERE "feed_items"."type" = 'event' AND "feed_items"."state"->>'status' = 'active';--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_source_type" CHECK (("feed_items"."type" = 'suggestion' AND "feed_items"."source_type" = 'agent') OR ("feed_items"."type" = 'event' AND "feed_items"."source_type" = 'platform-event'));--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_event" CHECK ("feed_items"."type" <> 'event' OR (
          jsonb_typeof("feed_items"."state") = 'object'
          AND "feed_items"."state"->>'status' IN ('active', 'dismissed')
          AND jsonb_typeof("feed_items"."content") = 'object'
          AND "feed_items"."content"->>'eventType' = 'automation-disabled'
          AND jsonb_typeof("feed_items"."content"->'automationId') = 'string'
          AND jsonb_typeof("feed_items"."content"->'workflowId') = 'string'
          AND jsonb_typeof("feed_items"."content"->'automationName') = 'string'
          AND jsonb_typeof("feed_items"."content"->'disabledAt') = 'string'
          AND jsonb_typeof("feed_items"."content"->'consecutiveFailures') = 'number'
          AND jsonb_typeof("feed_items"."content"->'recoveryScheduled') = 'boolean'
        ) IS TRUE);--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_type" CHECK ("feed_items"."type" IN ('suggestion', 'event'));--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_suggestion_state" CHECK ("feed_items"."type" <> 'suggestion' OR (
    jsonb_typeof("feed_items"."state") = 'object'
    AND "feed_items"."state"->>'status' IN ('active', 'consumed', 'removed')
    AND "feed_items"."state" ? 'selectedOptionId'
    AND ("feed_items"."state"->'selectedOptionId' = 'null'::jsonb OR jsonb_typeof("feed_items"."state"->'selectedOptionId') = 'string')
    AND jsonb_typeof("feed_items"."state"->'feedbacks') = 'array'
    AND jsonb_array_length("feed_items"."state"->'feedbacks') <= 100
  ) IS TRUE);--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_suggestion_content" CHECK ("feed_items"."type" <> 'suggestion' OR "feed_items"."state"->>'status' <> 'active' OR "feed_items"."content" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_suggestion_expiry" CHECK ("feed_items"."type" <> 'suggestion' OR "feed_items"."expires_at" IS NOT NULL);