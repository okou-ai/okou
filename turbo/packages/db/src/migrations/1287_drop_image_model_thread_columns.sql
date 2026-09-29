-- Thread image model projections have no readers since the image model became
-- a member setting (#37246); delete these events so the enum can be rebuilt.
-- Invalidated event cursors recover through the existing snapshot reload path.
DELETE FROM "chat_thread_events" WHERE "kind" = 'image_model_updated';--> statement-breakpoint
ALTER TYPE "public"."chat_thread_event_kind" RENAME TO "chat_thread_event_kind_retired";--> statement-breakpoint
CREATE TYPE "public"."chat_thread_event_kind" AS ENUM('created', 'renamed', 'deleted', 'pinned', 'unpinned', 'model_selection_updated', 'service_tier_updated', 'computer_use_host_updated', 'sort_touched', 'archived', 'unarchived');--> statement-breakpoint
ALTER TABLE "chat_thread_events" ALTER COLUMN "kind" SET DATA TYPE "public"."chat_thread_event_kind" USING "kind"::text::"public"."chat_thread_event_kind";--> statement-breakpoint
DROP TYPE "public"."chat_thread_event_kind_retired";--> statement-breakpoint
ALTER TABLE "chat_thread_events" DROP COLUMN "selected_image_model";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "selected_image_model";
