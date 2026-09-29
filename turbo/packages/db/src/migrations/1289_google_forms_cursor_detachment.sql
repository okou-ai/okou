-- Keep the existing per-automation response cursor when a physical watch is deleted.
-- R1 reconciliation reattaches it by automation ID and resumes from its original timestamp.
ALTER TABLE "google_forms_automation_cursors" DROP CONSTRAINT "google_forms_automation_cursors_watch_state_id_google_forms_watch_states_id_fk";
--> statement-breakpoint
ALTER TABLE "google_forms_automation_cursors" ALTER COLUMN "watch_state_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "google_forms_automation_cursors" ADD CONSTRAINT "google_forms_automation_cursors_watch_state_id_google_forms_watch_states_id_fk" FOREIGN KEY ("watch_state_id") REFERENCES "public"."google_forms_watch_states"("id") ON DELETE set null ON UPDATE no action;
