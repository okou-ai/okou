import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { officialWorkflowReconciliationWork } from "../schema/official-workflow-catalog";
import {
  officialWorkflowAutomationIdentities,
  workflows,
  workflowAutomations,
  workflowGithubProcessedEvents,
  workflowUserAutomationThreads,
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "../schema/workflow";

function explicitNames(table: Parameters<typeof getTableConfig>[0]): {
  readonly indexes: string[];
  readonly checks: string[];
} {
  const config = getTableConfig(table);
  return {
    indexes: config.indexes
      .flatMap((index) => {
        return index.config.name ? [index.config.name] : [];
      })
      .sort(),
    checks: config.checks
      .flatMap((check) => {
        return check.name ? [check.name] : [];
      })
      .sort(),
  };
}

describe("workflow schema physical identity", () => {
  it("keeps the workflow and Official reconciliation table mappings", () => {
    expect({
      officialWorkflowReconciliationWork: getTableConfig(
        officialWorkflowReconciliationWork,
      ).name,
      officialWorkflowAutomationIdentities: getTableConfig(
        officialWorkflowAutomationIdentities,
      ).name,
      workflows: getTableConfig(workflows).name,
      workflowAutomations: getTableConfig(workflowAutomations).name,
      workflowWebhookAutomations: getTableConfig(workflowWebhookAutomations)
        .name,
      workflowWebhookDeliveries: getTableConfig(workflowWebhookDeliveries).name,
      workflowGithubProcessedEvents: getTableConfig(
        workflowGithubProcessedEvents,
      ).name,
    }).toEqual({
      officialWorkflowReconciliationWork:
        "official_workflow_reconciliation_work",
      officialWorkflowAutomationIdentities:
        "official_workflow_automation_identities",
      workflows: "workflows",
      workflowAutomations: "workflow_automations",
      workflowWebhookAutomations: "workflow_webhook_automations",
      workflowWebhookDeliveries: "workflow_webhook_deliveries",
      workflowGithubProcessedEvents: "workflow_github_processed_events",
    });
  });

  it("exports the canonical tables through the root schema", () => {
    expect(schema.officialWorkflowReconciliationWork).toBe(
      officialWorkflowReconciliationWork,
    );
    expect(schema.officialWorkflowAutomationIdentities).toBe(
      officialWorkflowAutomationIdentities,
    );
    expect(schema.workflows).toBe(workflows);
    expect(schema.workflowAutomations).toBe(workflowAutomations);
    expect(schema.workflowWebhookAutomations).toBe(workflowWebhookAutomations);
    expect(schema.workflowWebhookDeliveries).toBe(workflowWebhookDeliveries);
    expect(schema.workflowGithubProcessedEvents).toBe(
      workflowGithubProcessedEvents,
    );
  });

  it("keeps every Official projection on the canonical Workflow relations", () => {
    const officialColumnNames = (
      table: Parameters<typeof getTableConfig>[0],
    ): string[] => {
      return getTableConfig(table)
        .columns.map(({ name }) => {
          return name;
        })
        .filter((name) => {
          return name.startsWith("official_");
        });
    };
    expect({
      workflows: officialColumnNames(workflows),
      workflowAutomations: officialColumnNames(workflowAutomations),
    }).toEqual({
      workflows: ["official_definition_name", "official_installation_state"],
      workflowAutomations: [
        "official_blueprint_key",
        "official_applied_fingerprint",
        "official_reconciliation_status",
        "official_parameter_bindings",
        "official_intended_enabled",
        "official_result_email_enabled",
      ],
    });
  });

  it("keeps every explicit index and check name in the touched schemas", () => {
    expect({
      officialWorkflowReconciliationWork: explicitNames(
        officialWorkflowReconciliationWork,
      ),
      officialWorkflowAutomationIdentities: explicitNames(
        officialWorkflowAutomationIdentities,
      ),
      workflows: explicitNames(workflows),
      workflowUserAutomationThreads: explicitNames(
        workflowUserAutomationThreads,
      ),
      workflowAutomations: explicitNames(workflowAutomations),
      workflowWebhookAutomations: explicitNames(workflowWebhookAutomations),
      workflowWebhookDeliveries: explicitNames(workflowWebhookDeliveries),
      workflowGithubProcessedEvents: explicitNames(
        workflowGithubProcessedEvents,
      ),
    }).toEqual({
      officialWorkflowReconciliationWork: {
        indexes: ["idx_official_workflow_reconciliation_work_due"],
        checks: [
          "official_workflow_reconciliation_work_attempt_count_check",
          "official_workflow_reconciliation_work_state_check",
        ],
      },
      officialWorkflowAutomationIdentities: {
        indexes: [
          "idx_official_workflow_automation_identities_automation_unique",
          "idx_official_workflow_automation_identities_key",
          "idx_official_workflow_automation_identities_workflow",
        ],
        checks: ["official_workflow_automation_identities_state_check"],
      },
      workflows: {
        indexes: [
          "idx_workflows_agent",
          "idx_workflows_org",
          "idx_workflows_org_owner",
          "idx_workflows_private_owner_agent_name_unique",
          "idx_workflows_public_agent_name_unique",
        ],
        checks: ["workflows_official_installation_check"],
      },
      workflowUserAutomationThreads: {
        indexes: [
          "idx_workflow_user_automation_threads_chat_thread",
          "idx_workflow_user_automation_threads_unique",
          "idx_workflow_user_automation_threads_workflow_user",
        ],
        checks: [],
      },
      workflowAutomations: {
        indexes: [
          "idx_workflow_automations_event_connector",
          "idx_workflow_automations_next_run",
          "idx_workflow_automations_official_blueprint_unique",
          "idx_workflow_automations_org",
          "idx_workflow_automations_workflow",
        ],
        checks: [
          "workflow_automations_autonomy_budget_check",
          "workflow_automations_official_binding_check",
          "workflow_automations_schedule_config_check",
        ],
      },
      workflowWebhookAutomations: {
        indexes: ["idx_workflow_webhook_automations_token_hash"],
        checks: [],
      },
      workflowWebhookDeliveries: {
        indexes: [
          "idx_workflow_webhook_deliveries_automation_key",
          "idx_workflow_webhook_deliveries_automation_received",
        ],
        checks: [],
      },
      workflowGithubProcessedEvents: {
        indexes: [
          "idx_workflow_github_processed_automation_delivery",
          "idx_workflow_github_processed_subject",
        ],
        checks: [],
      },
    });
  });
});
