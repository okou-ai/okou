import {
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Physical storage of the retired Official Automation completion email.
 *
 * Besides draining release-1 APIs, only the bounded legacy consumer writes
 * these dedupe claims, through `runtime/legacy-official-result-email`
 * (#39524). Release 3 of #39378 removes that consumer and drops the table after
 * outgoing APIs drain and rollback excludes them.
 */
export const officialAutomationResultEmailClaims = pgTable(
  "official_automation_result_email_claims",
  {
    runId: uuid("run_id").notNull(),
    workflowAutomationId: uuid("workflow_automation_id").notNull(),
    emailOutboxId: uuid("email_outbox_id").defaultRandom().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "official_automation_result_email_claims_pkey",
        columns: [table.runId, table.workflowAutomationId],
      }),
      uniqueIndex("official_automation_result_email_claims_outbox_unique").on(
        table.emailOutboxId,
      ),
    ];
  },
);
