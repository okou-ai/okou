-- Commit separately from 1365: validation must not retain its ACCESS EXCLUSIVE locks.
-- No backfill, timeout override or explicit lock. Preflight must pass before release.
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_canonical_selection_check";--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_runtime_pair_check";--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_personal_capture_check";--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_builtin_capture_owner_check";--> statement-breakpoint
ALTER TABLE "agent_runs" VALIDATE CONSTRAINT "agent_runs_usage_capture_check";--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_canonical_selection_check";--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_canonical_annotation_check";--> statement-breakpoint
ALTER TABLE "chat_thread_events" VALIDATE CONSTRAINT "chat_thread_events_canonical_selection_check";--> statement-breakpoint
ALTER TABLE "chat_threads" VALIDATE CONSTRAINT "chat_threads_canonical_selection_check";--> statement-breakpoint
ALTER TABLE "org_members_metadata" VALIDATE CONSTRAINT "org_members_metadata_canonical_selection_check";
