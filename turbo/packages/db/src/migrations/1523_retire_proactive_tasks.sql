UPDATE "org_members_metadata"
SET "proactive_action_enabled" = false, "updated_at" = now()
WHERE "proactive_action_enabled" = true;
--> statement-breakpoint
UPDATE "workflow_automations" AS automation
SET "enabled" = false,
    "next_run_at" = NULL,
    "official_intended_enabled" = false,
    "updated_at" = now()
FROM "workflows" AS workflow
WHERE automation.workflow_id = workflow.id
  AND workflow.official_definition_name IN ('proactive-action', 'proactive-planning', 'proactive-jobs');
--> statement-breakpoint
DROP TABLE "user_jobs";
