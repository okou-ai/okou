-- #33747: the owner explicitly retired the withdrawn privacy feature's stored
-- choices, revisions and capture receipts. Ship prepared account cleanup before
-- this migration and exclude unconditional-cleanup APIs from rollback.
-- Prepared cleanup acquires the shared form before checking relation presence.
SELECT pg_advisory_xact_lock(hashtext('marketing_privacy_storage_retirement'));
--> statement-breakpoint
-- Match the parent-to-child cascade order of an in-flight account deletion.
LOCK TABLE public.privacy_choices,
  public.privacy_choice_revisions,
  public.marketing_privacy_receipts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TRIGGER marketing_privacy_withdrawal ON public.privacy_choices;
--> statement-breakpoint
-- Restrict drops to the three explicitly retired tables and their own objects.
-- Unexpected external dependencies must abort the entire migration.
DROP TABLE public.marketing_privacy_receipts;
--> statement-breakpoint
DROP TABLE public.privacy_choice_revisions;
--> statement-breakpoint
DROP TABLE public.privacy_choices;
--> statement-breakpoint
DROP FUNCTION public.invalidate_marketing_privacy_epochs();
