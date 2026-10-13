-- Release 3 of #39378. Migrations run before API promotion, and the outgoing
-- release-2 API's bounded legacy consumer (#39524) still writes this storage for
-- any pending or failed legacy callback. Ship only after the normal-channel
-- drain gate shows none remains. Plain drops keep RESTRICT semantics, so an
-- unexpected dependent object fails the migration.
DROP TABLE "official_automation_result_email_claims";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_source_identity_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_official_binding_check";--> statement-breakpoint
DROP INDEX "email_outbox_source_run_automation_unique";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP COLUMN "source_run_id";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP COLUMN "source_workflow_automation_id";--> statement-breakpoint
ALTER TABLE "workflow_automations" DROP COLUMN "official_result_email_enabled";--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_official_binding_check" CHECK ((
          "workflow_automations"."official_blueprint_key" IS NULL
          AND "workflow_automations"."official_applied_fingerprint" IS NULL
          AND "workflow_automations"."official_reconciliation_status" IS NULL
          AND "workflow_automations"."official_parameter_bindings" IS NULL
          AND "workflow_automations"."official_intended_enabled" IS NULL
        ) OR (
          "workflow_automations"."official_blueprint_key" IS NOT NULL
          AND "workflow_automations"."official_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "workflow_automations"."official_reconciliation_status" IN ('current', 'reconciling', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof("workflow_automations"."official_parameter_bindings") = 'array'
          AND "workflow_automations"."official_intended_enabled" IS NOT NULL
        ));