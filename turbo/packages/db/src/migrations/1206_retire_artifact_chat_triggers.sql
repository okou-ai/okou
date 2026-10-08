-- #33749: API services own catalog writes/deletes, chat event append/cursors,
-- and computer-host/cloud-browser normalization before this contract migration.
-- Ship only after every serving API instance and supported rollback binary uses
-- the explicit writes; older versions depend on these triggers.
DROP TRIGGER run_uploaded_files_queue_artifact_catalog ON public.run_uploaded_files;
--> statement-breakpoint
DROP TRIGGER run_uploaded_files_delete_artifact_registry ON public.run_uploaded_files;
--> statement-breakpoint
DROP TRIGGER hosted_sites_delete_artifact_registry ON public.hosted_sites;
--> statement-breakpoint
DROP TRIGGER image_artifacts_delete_artifact_registry ON public.image_artifacts;
--> statement-breakpoint
DROP TRIGGER video_artifacts_delete_artifact_registry ON public.video_artifacts;
--> statement-breakpoint
DROP TRIGGER presentation_artifacts_delete_artifact_registry ON public.presentation_artifacts;
--> statement-breakpoint
DROP TRIGGER chat_events_reject_update ON public.chat_events;
--> statement-breakpoint
DROP TRIGGER chat_thread_events_reject_update ON public.chat_thread_events;
--> statement-breakpoint
DROP TRIGGER allocate_legacy_chat_thread_event_seq_id ON public.chat_thread_events;
--> statement-breakpoint
DROP TRIGGER fill_legacy_chat_thread_snapshot_event_seq_id ON public.chat_thread_snapshots;
--> statement-breakpoint
DROP TRIGGER chat_threads_normalize_computer_access ON public.chat_threads;
--> statement-breakpoint
DROP FUNCTION public.queue_artifact_catalog_file();
--> statement-breakpoint
DROP FUNCTION public.delete_artifact_registry_entity();
--> statement-breakpoint
DROP FUNCTION public.reject_chat_event_source_update();
--> statement-breakpoint
DROP FUNCTION public.allocate_legacy_chat_thread_event_seq_id();
--> statement-breakpoint
DROP FUNCTION public.fill_legacy_chat_thread_snapshot_event_seq_id();
--> statement-breakpoint
DROP FUNCTION public.chat_threads_normalize_computer_access();
