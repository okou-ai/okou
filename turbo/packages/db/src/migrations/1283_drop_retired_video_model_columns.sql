-- Retired video_model_updated events replay as no-ops; delete them so the
-- enum value can be removed. Cursor clients whose last event is deleted get 410
-- and reload the snapshot.
DELETE FROM "chat_thread_events" WHERE "kind" = 'video_model_updated';--> statement-breakpoint
ALTER TYPE "public"."chat_thread_event_kind" RENAME TO "chat_thread_event_kind_retired";--> statement-breakpoint
CREATE TYPE "public"."chat_thread_event_kind" AS ENUM('created', 'renamed', 'deleted', 'pinned', 'unpinned', 'model_selection_updated', 'service_tier_updated', 'computer_use_host_updated', 'image_model_updated', 'sort_touched', 'archived', 'unarchived');--> statement-breakpoint
ALTER TABLE "chat_thread_events" ALTER COLUMN "kind" SET DATA TYPE "public"."chat_thread_event_kind" USING "kind"::text::"public"."chat_thread_event_kind";--> statement-breakpoint
DROP TYPE "public"."chat_thread_event_kind_retired";--> statement-breakpoint
ALTER TABLE "chat_thread_events" DROP COLUMN "selected_video_model";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "selected_video_model";--> statement-breakpoint
ALTER TABLE "org_members_metadata" DROP COLUMN "selected_video_model";--> statement-breakpoint
-- agent_runs is changed last so its ACCESS EXCLUSIVE lock is held briefly.
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_metadata_presence_check";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN "selected_video_model";--> statement-breakpoint
-- Validated without an ACCESS EXCLUSIVE lock by the next migration.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_metadata_presence_check" CHECK ((
          (
            "agent_runs"."trigger_source" IS NULL AND
            "agent_runs"."autonomy_budget" IS NULL AND
            "agent_runs"."workflow_automation_id" IS NULL AND
            "agent_runs"."model_provider" IS NULL AND
            "agent_runs"."model_provider_id" IS NULL AND
            "agent_runs"."model_provider_credential_scope" IS NULL AND
            "agent_runs"."selected_model" IS NULL AND
            "agent_runs"."model_runtime_provider" IS NULL AND
            "agent_runs"."model_runtime_model" IS NULL AND
            "agent_runs"."built_in_model_key_id" IS NULL AND
            "agent_runs"."codex_service_tier" IS NULL AND
            "agent_runs"."selected_image_model" IS NULL AND
            "agent_runs"."chat_thread_id" IS NULL AND
            "agent_runs"."api_started_at" IS NULL AND
            "agent_runs"."first_assistant_event_acknowledged_at" IS NULL AND
            "agent_runs"."summary" IS NULL AND
            "agent_runs"."trigger_brief" IS NULL
          ) OR (
            "agent_runs"."trigger_source" IS NOT NULL AND
            "agent_runs"."autonomy_budget" IS NOT NULL
          )
        )) NOT VALID;
