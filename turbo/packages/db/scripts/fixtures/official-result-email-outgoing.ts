import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Frozen column lists from canonical API 1.729.0 (a3f7131), before release 2
// of #39378 removed the platform completion email from runtime SQL. Retain
// until release 3's physical contraction is deployed and accepted.
export const outgoingWorkflowAutomations = pgTable("workflow_automations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  workflowId: uuid("workflow_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  kind: varchar("kind", { length: 16 }).notNull().default("schedule"),
  eventType: varchar("event_type", { length: 64 }),
  eventConfig: jsonb("event_config"),
  eventConnectorId: uuid("event_connector_id"),
  scheduleType: varchar("schedule_type", { length: 16 }),
  cronExpression: varchar("cron_expression", { length: 100 }),
  intervalSeconds: integer("interval_seconds"),
  atTime: timestamp("at_time"),
  timezone: varchar("timezone", { length: 50 }).default("UTC").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  nextRunAt: timestamp("next_run_at"),
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
  }),
  officialParameterBindings: jsonb("official_parameter_bindings"),
  officialIntendedEnabled: boolean("official_intended_enabled"),
  officialResultEmailEnabled: boolean("official_result_email_enabled"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const outgoingEmailOutbox = pgTable("email_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromAddress: text("from_address").notNull(),
  toAddresses: jsonb("to_addresses").notNull(),
  ccAddresses: jsonb("cc_addresses"),
  subject: text("subject").notNull(),
  replyTo: text("reply_to"),
  headers: jsonb("headers"),
  template: jsonb("template").notNull(),
  sourceRunId: uuid("source_run_id"),
  sourceWorkflowAutomationId: uuid("source_workflow_automation_id"),
  providerIdempotencyKey: text("provider_idempotency_key"),
  providerRequest: jsonb("provider_request"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  resendId: text("resend_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const outgoingOfficialAutomationResultEmailClaims = pgTable(
  "official_automation_result_email_claims",
  {
    runId: uuid("run_id").notNull(),
    workflowAutomationId: uuid("workflow_automation_id").notNull(),
    emailOutboxId: uuid("email_outbox_id").defaultRandom().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);
