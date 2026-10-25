-- #42572 must be serving, its outgoing requests drained, and rollback to
-- table-using API artifacts excluded before this separate contraction.
-- Hold the DDL locks across the data/dependency census and all changes.
LOCK TABLE "public"."workflow_automations", "public"."stripe_workflow_automation_health", "public"."stripe_workflow_deliveries" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  dependent_objects text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.workflow_automations WHERE event_type = 'stripe-invoice-paid')
    OR EXISTS (SELECT 1 FROM public.stripe_workflow_automation_health)
    OR EXISTS (SELECT 1 FROM public.stripe_workflow_deliveries)
  THEN
    RAISE EXCEPTION 'Stripe invoice-paid retirement requires empty automation, health and delivery state'
      USING ERRCODE = '55000';
  END IF;

  -- RESTRICT handles tracked external dependencies. It does not protect local
  -- triggers or string-bodied routines, so inspect those before dropping data.
  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0) AS object_name
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(stripe_workflow_automation_health|stripe_workflow_deliveries)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid IN ('public.stripe_workflow_automation_health'::regclass, 'public.stripe_workflow_deliveries'::regclass)
      AND NOT tgisinternal
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Stripe invoice-paid storage dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
-- Never cascade into an unexpected consumer. A later failure rolls back both
-- drops, the CHECK replacement and the migration journal entry together.
DROP TABLE "public"."stripe_workflow_automation_health" RESTRICT;
--> statement-breakpoint
DROP TABLE "public"."stripe_workflow_deliveries" RESTRICT;
--> statement-breakpoint
ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_schedule_config_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_schedule_config_check" CHECK ((
            kind = 'schedule'
            AND event_type IS NULL
            AND event_config IS NULL
            AND (
              (schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND at_time IS NULL)
              OR (schedule_type = 'loop' AND interval_seconds IS NOT NULL AND cron_expression IS NULL AND at_time IS NULL)
              OR (schedule_type = 'once' AND at_time IS NOT NULL AND cron_expression IS NULL AND interval_seconds IS NULL)
            )
          )
          OR (
            kind = 'event'
            AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-forms-response-submitted', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          ));
