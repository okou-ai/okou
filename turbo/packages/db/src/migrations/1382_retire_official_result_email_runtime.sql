ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_official_binding_check";--> statement-breakpoint
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_official_binding_check" CHECK ((
          "workflow_automations"."official_blueprint_key" IS NULL
          AND "workflow_automations"."official_applied_fingerprint" IS NULL
          AND "workflow_automations"."official_reconciliation_status" IS NULL
          AND "workflow_automations"."official_parameter_bindings" IS NULL
          AND "workflow_automations"."official_intended_enabled" IS NULL
          AND "workflow_automations"."official_result_email_enabled" IS NULL
        ) OR (
          "workflow_automations"."official_blueprint_key" IS NOT NULL
          AND "workflow_automations"."official_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "workflow_automations"."official_reconciliation_status" IN ('current', 'reconciling', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof("workflow_automations"."official_parameter_bindings") = 'array'
          AND "workflow_automations"."official_intended_enabled" IS NOT NULL
        ));