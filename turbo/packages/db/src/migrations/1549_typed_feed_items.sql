-- Preserve existing identities, content, feedback and timestamps in the Feed envelope.
ALTER TABLE "agent_suggestion_items" RENAME TO "feed_items";
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "type" text;
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "state" jsonb;
--> statement-breakpoint
UPDATE "feed_items" SET
  "type" = 'suggestion',
  "state" = jsonb_build_object(
    'status', "status",
    'selectedOptionId', "selected_option_id",
    'feedbacks', "feedbacks"
  );
--> statement-breakpoint
DROP INDEX "agent_suggestion_items_active_order";
--> statement-breakpoint
DROP INDEX "agent_suggestion_items_pending_feedback";
--> statement-breakpoint
DROP INDEX "agent_suggestion_items_expiry";
--> statement-breakpoint
DROP INDEX "agent_suggestion_items_receipts";
--> statement-breakpoint
ALTER TABLE "feed_items"
  DROP COLUMN "status",
  DROP COLUMN "selected_option_id",
  DROP COLUMN "feedbacks",
  ALTER COLUMN "type" SET NOT NULL,
  ALTER COLUMN "state" SET NOT NULL,
  ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "feed_items" RENAME CONSTRAINT "agent_suggestion_items_org_id_user_id_id_pk" TO "feed_items_org_id_user_id_id_pk";
--> statement-breakpoint
ALTER TABLE "feed_items"
  ADD CONSTRAINT "feed_items_type" CHECK ("feed_items"."type" = 'suggestion'),
  ADD CONSTRAINT "feed_items_suggestion_state" CHECK ((
    jsonb_typeof("feed_items"."state") = 'object'
    AND "feed_items"."state"->>'status' IN ('active', 'consumed', 'removed')
    AND "feed_items"."state" ? 'selectedOptionId'
    AND ("feed_items"."state"->'selectedOptionId' = 'null'::jsonb OR jsonb_typeof("feed_items"."state"->'selectedOptionId') = 'string')
    AND jsonb_typeof("feed_items"."state"->'feedbacks') = 'array'
    AND jsonb_array_length("feed_items"."state"->'feedbacks') <= 100
  ) IS TRUE),
  ADD CONSTRAINT "feed_items_suggestion_content" CHECK ("feed_items"."state"->>'status' <> 'active' OR "feed_items"."content" IS NOT NULL),
  ADD CONSTRAINT "feed_items_suggestion_expiry" CHECK ("feed_items"."expires_at" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "feed_items_active_order" ON "feed_items" USING btree ("org_id","user_id","priority" DESC NULLS LAST,"created_at","id") WHERE "feed_items"."type" = 'suggestion' AND "feed_items"."state"->>'status' = 'active';--> statement-breakpoint
CREATE INDEX "feed_items_pending_feedback" ON "feed_items" USING btree ("org_id","user_id","updated_at","id") WHERE jsonb_path_exists("feed_items"."state"->'feedbacks', '$[*] ? (@.learnedAt == null)');--> statement-breakpoint
CREATE INDEX "feed_items_expiry" ON "feed_items" USING btree ("expires_at","org_id","user_id","id");--> statement-breakpoint
CREATE INDEX "feed_items_receipts" ON "feed_items" USING btree ("org_id","user_id","updated_at" DESC NULLS LAST,"id") WHERE "feed_items"."state"->>'status' <> 'active';
