import {
  boolean,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  OfficialWorkflowParameterBindings,
  WorkflowAutomationEventConfig,
} from "@okouai/db/jsonb-contracts/workflow";
import type {
  OfficialWorkflowReconciliationStatus,
  WorkflowAutomationEventType,
  WorkflowAutomationKind,
  WorkflowScheduleType,
} from "../schema/workflow";

/**
 * Shared physical and runtime `workflow_automations` column builders.
 *
 * The retired `official_result_email_enabled` column is declared only by the
 * physical schema, so runtime statements never name it.
 */
export function workflowAutomationColumns(
  workflowId: () => AnyPgColumn,
  connectorId: () => AnyPgColumn,
) {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        (): AnyPgColumn => {
          return workflowId();
        },
        { onDelete: "cascade" },
      ),
    // Execution identity: runs fire as (org_id, owner_user_id), resolving the
    // owner's secrets / connectors / credits.
    ownerUserId: text("owner_user_id").notNull(),
    kind: varchar("kind", { length: 16 })
      .$type<WorkflowAutomationKind>()
      .notNull()
      .default("schedule"),
    eventType: varchar("event_type", {
      length: 64,
    }).$type<WorkflowAutomationEventType>(),
    eventConfig: jsonb("event_config").$type<WorkflowAutomationEventConfig>(),
    eventConnectorId: uuid("event_connector_id").references(
      (): AnyPgColumn => {
        return connectorId();
      },
      { onDelete: "set null" },
    ),
    scheduleType: varchar("schedule_type", {
      length: 16,
    }).$type<WorkflowScheduleType>(),
    cronExpression: varchar("cron_expression", { length: 100 }),
    intervalSeconds: integer("interval_seconds"),
    atTime: timestamp("at_time"),
    timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    nextRunAt: timestamp("next_run_at"),
    /** Retry gate for the exact unclaimed anchor; a new anchor bypasses it. */
    deferredAnchorAt: timestamp("deferred_anchor_at"),
    deferredUntil: timestamp("deferred_until"),
    deferredReason: varchar("deferred_reason", { length: 32 }),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    autonomyBudget: integer("autonomy_budget").notNull().default(32),
    officialBlueprintKey: varchar("official_blueprint_key", { length: 64 }),
    officialAppliedFingerprint: varchar("official_applied_fingerprint", {
      length: 64,
    }),
    officialReconciliationStatus: varchar("official_reconciliation_status", {
      length: 32,
    }).$type<OfficialWorkflowReconciliationStatus>(),
    officialParameterBindings: jsonb(
      "official_parameter_bindings",
    ).$type<OfficialWorkflowParameterBindings>(),
    officialIntendedEnabled: boolean("official_intended_enabled"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
