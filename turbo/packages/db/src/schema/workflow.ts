import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  integer,
  boolean,
  uniqueIndex,
  index,
  check,
  foreignKey,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agent";
import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";
import type {
  OfficialWorkflowParameterBindings,
  WorkflowAutomationEventConfig,
} from "@okouai/db/jsonb-contracts/workflow";
export type { WorkflowAutomationEventConfig } from "@okouai/db/jsonb-contracts/workflow";

/**
 * Workflow visibility.
 *
 * Public workflows are visible within the org. Private workflows are visible
 * only to their owner. The backing package is still a skill directory and is
 * stored through the existing custom-skill volume storage name.
 */
export type WorkflowVisibility = "public" | "private";
export type OfficialWorkflowInstallationState = "installing" | "installed";
export type OfficialWorkflowReconciliationStatus =
  | "current"
  | "reconciling"
  | "needs_reconfiguration"
  | "failed";
export type OfficialWorkflowAutomationIdentityState =
  | "active"
  | "reconciling"
  | "needs_reconfiguration"
  | "failed"
  | "removed";

/**
 * Workflows table
 * Org-scoped registry of workflows. Each row represents workflow metadata.
 * Workflow content is stored in the storages system.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    // Hard 1:N ownership: every workflow belongs to exactly one agent. Deleting
    // the agent cascades to its workflows and their volumes.
    agentId: uuid("agent_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<WorkflowVisibility>()
      .notNull()
      .default("private"),
    // Instruction body (the SKILL.md content below the frontmatter). DB is the
    // single source of truth; the SKILL.md written to the volume is synthesized
    // from (name, description, instruction).
    instruction: text("instruction"),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    officialDefinitionName: varchar("official_definition_name", { length: 64 }),
    officialInstallationState: varchar("official_installation_state", {
      length: 32,
    }).$type<OfficialWorkflowInstallationState>(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      canonicalAgentFk: foreignKey({
        name: "workflows_agent_id_agents_id_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      agentIdx: index("idx_workflows_agent").on(table.agentId, table.name),
      // Public workflow slugs are the shared namespace for an agent. Private
      // workflows may duplicate public slugs as user-specific forks/overrides,
      // but one owner cannot have two private workflows with the same slug on
      // the same agent.
      publicAgentNameIdx: uniqueIndex("idx_workflows_public_agent_name_unique")
        .on(table.orgId, table.agentId, table.name)
        .where(sql`visibility = 'public'`),
      privateOwnerAgentNameIdx: uniqueIndex(
        "idx_workflows_private_owner_agent_name_unique",
      )
        .on(table.orgId, table.agentId, table.ownerUserId, table.name)
        .where(sql`visibility = 'private'`),
      orgIdx: index("idx_workflows_org").on(table.orgId),
      ownerIdx: index("idx_workflows_org_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
      officialInstallationCheck: check(
        "workflows_official_installation_check",
        sql`(
          ${table.officialDefinitionName} IS NULL
          AND ${table.officialInstallationState} IS NULL
        ) OR (
          ${table.officialDefinitionName} IS NOT NULL
          AND ${table.officialInstallationState} IN ('installing', 'installed')
          AND ${table.officialDefinitionName} = ${table.name}
          AND ${table.visibility} = 'private'
          AND ${table.instruction} IS NULL
          AND ${table.displayName} IS NULL
          AND ${table.description} IS NULL
        )`,
      ),
    };
  },
);

/**
 * Shared automation chat thread for one workflow execution owner.
 *
 * Automation-fired runs use the automation owner's identity. Keep the linked
 * chat thread at the workflow-user level so every automation owned by the same
 * user for a workflow writes to one conversation.
 */
export const workflowUserAutomationThreads = pgTable(
  "workflow_user_automation_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return workflows.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_user_automation_threads_unique").on(
        table.orgId,
        table.userId,
        table.workflowId,
      ),
      index("idx_workflow_user_automation_threads_chat_thread").on(
        table.chatThreadId,
      ),
      index("idx_workflow_user_automation_threads_workflow_user").on(
        table.workflowId,
        table.userId,
      ),
    ];
  },
);

/**
 * Schedule sub-type for a workflow automation.
 *
 * - `cron`: recurring at wall-clock times defined by a cron expression.
 * - `loop`: re-scheduled `interval_seconds` after each completion (no overlap).
 * - `once`: fires once at `at_time`, then auto-disables.
 *
 * Uses the same schedule semantics as the retired automation trigger rows.
 */
export type WorkflowScheduleType = "cron" | "loop" | "once";
export type WorkflowAutomationKind = "schedule" | "event";
export type WorkflowAutomationEventType =
  | "chat-run-finished"
  | "gmail-new-message"
  | "gmail-label-applied"
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
  | "github-workflow-run-completed"
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled"
  | "google-forms-response-submitted"
  | "google-meet-transcript-generated"
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated"
  | "stripe-invoice-paid"
  | "webhook-received";

export type WorkflowWebhookDisabledReason = "paid_plan_required";

/**
 * Workflow automations.
 *
 * An automation answers "when" a workflow runs; the workflow's SKILL.md is the
 * "what". Automation chat is shared at the workflow-user level by
 * `workflow_user_automation_threads`.
 *
 * Schedule automations are polled by `next_run_at`. Event automations keep
 * `next_run_at = NULL` and fire from their event-specific junction.
 */
export const workflowAutomations = pgTable(
  "workflow_automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return workflows.id;
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
      () => {
        return connectors.id;
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
    autonomyBudget: integer("autonomy_budget").notNull().default(10),
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
    officialResultEmailEnabled: boolean("official_result_email_enabled"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_workflow_automations_workflow").on(table.workflowId),
      index("idx_workflow_automations_org").on(table.orgId),
      index("idx_workflow_automations_event_connector").on(
        table.eventConnectorId,
      ),
      // Partial index for the time poller: enabled automations with a due run.
      index("idx_workflow_automations_next_run")
        .on(table.nextRunAt)
        .where(sql`enabled = true`),
      index("idx_workflow_automations_deferred_retry")
        .on(table.deferredUntil, table.nextRunAt)
        .where(sql`${table.deferredUntil} IS NOT NULL`),
      check(
        "workflow_automations_deferral_pair_check",
        sql`(
          ${table.deferredAnchorAt} IS NULL
          AND ${table.deferredUntil} IS NULL
          AND ${table.deferredReason} IS NULL
        ) OR (
          ${table.deferredAnchorAt} IS NOT NULL
          AND ${table.deferredUntil} IS NOT NULL
          AND ${table.deferredReason} IS NOT NULL
        )`,
      ),
      // Each automation kind carries exactly its own config.
      check(
        "workflow_automations_schedule_config_check",
        sql`(
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
            AND event_type IN ('chat-run-finished', 'gmail-new-message', 'gmail-label-applied', 'github-deployment-status-created', 'github-issue-comment-created', 'github-pull-request', 'github-pull-request-review-submitted', 'github-workflow-job-completed', 'github-workflow-run-completed', 'google-calendar-event-created', 'google-calendar-event-updated', 'google-calendar-event-cancelled', 'google-forms-response-submitted', 'google-meet-transcript-generated', 'notion-child-page-created', 'notion-database-item-created', 'notion-page-content-updated', 'stripe-invoice-paid', 'webhook-received')
            AND event_config IS NOT NULL
            AND schedule_type IS NULL
            AND cron_expression IS NULL
            AND interval_seconds IS NULL
            AND at_time IS NULL
          )`,
      ),
      check(
        "workflow_automations_autonomy_budget_check",
        sql`${table.autonomyBudget} BETWEEN 0 AND 10`,
      ),
      uniqueIndex("idx_workflow_automations_official_blueprint_unique")
        .on(table.workflowId, table.officialBlueprintKey)
        .where(sql`${table.officialBlueprintKey} IS NOT NULL`),
      check(
        "workflow_automations_official_binding_check",
        sql`(
          ${table.officialBlueprintKey} IS NULL
          AND ${table.officialAppliedFingerprint} IS NULL
          AND ${table.officialReconciliationStatus} IS NULL
          AND ${table.officialParameterBindings} IS NULL
          AND ${table.officialIntendedEnabled} IS NULL
          AND ${table.officialResultEmailEnabled} IS NULL
        ) OR (
          ${table.officialBlueprintKey} IS NOT NULL
          AND ${table.officialAppliedFingerprint} ~ '^[0-9a-f]{64}$'
          AND ${table.officialReconciliationStatus} IN ('current', 'reconciling', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof(${table.officialParameterBindings}) = 'array'
          AND ${table.officialIntendedEnabled} IS NOT NULL
          AND ${table.officialResultEmailEnabled} IS NOT NULL
        )`,
      ),
    ];
  },
);

/**
 * Permanent logical identity for one Official Automation Blueprint projection.
 *
 * Executable configuration remains in `workflow_automations`. This row
 * survives Blueprint removal and can represent a newly introduced Blueprint
 * whose required parameters are not yet resolvable, without exposing an
 * incomplete trigger configuration to mixed-version readers.
 */
export const officialWorkflowAutomationIdentities = pgTable(
  "official_workflow_automation_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id").notNull(),
    automationId: uuid("automation_id"),
    blueprintKey: varchar("blueprint_key", { length: 64 }).notNull(),
    state: varchar("state", { length: 32 })
      .$type<OfficialWorkflowAutomationIdentityState>()
      .notNull(),
    retainedParameterBindings: jsonb(
      "retained_parameter_bindings",
    ).$type<OfficialWorkflowParameterBindings>(),
    retainedIntendedEnabled: boolean("retained_intended_enabled"),
    retainedAppliedFingerprint: varchar("retained_applied_fingerprint", {
      length: 64,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "official_workflow_automation_identity_workflow_fk",
        columns: [table.workflowId],
        foreignColumns: [workflows.id],
      }).onDelete("cascade"),
      foreignKey({
        name: "official_workflow_automation_identity_automation_fk",
        columns: [table.automationId],
        foreignColumns: [workflowAutomations.id],
      }).onDelete("set null"),
      uniqueIndex("idx_official_workflow_automation_identities_key").on(
        table.workflowId,
        table.blueprintKey,
      ),
      uniqueIndex(
        "idx_official_workflow_automation_identities_automation_unique",
      )
        .on(table.automationId)
        .where(sql`${table.automationId} IS NOT NULL`),
      index("idx_official_workflow_automation_identities_workflow").on(
        table.workflowId,
      ),
      check(
        "official_workflow_automation_identities_state_check",
        sql`(
          ${table.state} = 'active'
          AND ${table.automationId} IS NOT NULL
          AND ${table.retainedParameterBindings} IS NULL
          AND ${table.retainedIntendedEnabled} IS NULL
          AND ${table.retainedAppliedFingerprint} IS NULL
        ) OR (
          ${table.state} IN ('reconciling', 'needs_reconfiguration', 'failed', 'removed')
          AND ${table.automationId} IS NULL
          AND jsonb_typeof(${table.retainedParameterBindings}) = 'array'
          AND ${table.retainedIntendedEnabled} IS NOT NULL
          AND (
            ${table.retainedAppliedFingerprint} IS NULL
            OR ${table.retainedAppliedFingerprint} ~ '^[0-9a-f]{64}$'
          )
        )`,
      ),
    ];
  },
);

export const workflowWebhookAutomations = pgTable(
  "workflow_webhook_automations",
  {
    automationId: uuid("automation_id")
      .primaryKey()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    tokenHash: text("token_hash").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    secretLastFour: varchar("secret_last_four", { length: 4 }).notNull(),
    disabledReason: varchar("disabled_reason", {
      length: 64,
    }).$type<WorkflowWebhookDisabledReason>(),
    lastReceivedAt: timestamp("last_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_webhook_automations_token_hash").on(
        table.tokenHash,
      ),
    ];
  },
);

export const workflowWebhookDeliveries = pgTable(
  "workflow_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    deliveryKey: text("delivery_key").notNull(),
    bodySha256: text("body_sha256").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    runId: uuid("run_id"),
    errorMessage: text("error_message"),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_webhook_deliveries_automation_key").on(
        table.automationId,
        table.deliveryKey,
      ),
      index("idx_workflow_webhook_deliveries_automation_received").on(
        table.automationId,
        table.receivedAt,
      ),
    ];
  },
);

export const workflowGithubProcessedEvents = pgTable(
  "workflow_github_processed_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    githubDeliveryId: varchar("github_delivery_id", { length: 255 }).notNull(),
    repo: varchar("repo", { length: 255 }).notNull(),
    subjectType: varchar("subject_type", { length: 32 }),
    subjectNumber: integer("subject_number"),
    action: varchar("action", { length: 64 }).notNull(),
    labelNameNormalized: varchar("label_name_normalized", {
      length: 255,
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_github_processed_automation_delivery").on(
        table.automationId,
        table.githubDeliveryId,
      ),
      index("idx_workflow_github_processed_subject").on(
        table.repo,
        table.subjectType,
        table.subjectNumber,
      ),
    ];
  },
);
