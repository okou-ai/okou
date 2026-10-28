import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { sql, type SQL } from "drizzle-orm";
import type { billingRunAttributionWrite } from "./managed-usage-attribution";
import { pendingLaunchInsertSql } from "./pending-launch-sql";

/** R1 capture depends on the returned Run key, and retains historical CAS. */
export function pendingLaunchBillingAttributionSql(
  capture: ReturnType<typeof billingRunAttributionWrite>,
  insertedRunId: SQL,
  eligibility: SQL,
) {
  const table = billingRunAttribution;
  const { values, conflict } = capture;
  return pendingLaunchInsertSql(
    table,
    { ...values, runId: insertedRunId },
    ["runId"],
    eligibility,
    sql`(${sql.identifier(table.runId.name)}) DO UPDATE SET
      ${sql.identifier(table.runId.name)} = ${sql.param(conflict.set.runId, table.runId)},
      ${sql.identifier(table.threadId.name)} = ${conflict.set.threadId},
      ${sql.identifier(table.threadContext.name)} = ${conflict.set.threadContext},
      ${sql.identifier(table.runTerminalStatus.name)} = ${conflict.set.runTerminalStatus},
      ${sql.identifier(table.runCompletedAt.name)} = ${conflict.set.runCompletedAt},
      ${sql.identifier(table.runLifecycleContext.name)} = ${conflict.set.runLifecycleContext}
      WHERE ${conflict.setWhere}`,
  );
}
