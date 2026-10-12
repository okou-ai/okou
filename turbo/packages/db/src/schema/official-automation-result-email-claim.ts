import {
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Migration-only storage of the retired Official Automation completion email.
 *
 * No runtime code reads or writes these dedupe claims. The table stays until
 * release 3 of #39378 drops it after outgoing APIs drain and rollback excludes
 * them.
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
