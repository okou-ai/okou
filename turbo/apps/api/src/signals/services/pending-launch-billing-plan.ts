import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { billingRunAttributionWrite } from "./managed-usage-attribution";

/** R1 capture depends on the returned Run key, and retains historical CAS. */
export function pendingLaunchBillingAttributionSql(
  capture: ReturnType<typeof billingRunAttributionWrite>,
  insertedRunId: SQL,
) {
  const table = billingRunAttribution;
  const { values, conflict } = capture;
  return new PgDialect().buildInsertQuery({
    table,
    values: [
      {
        runId: insertedRunId,
        orgId: sql.param(values.orgId, table.orgId),
        userId: sql.param(values.userId, table.userId),
        runStartedAt: values.runStartedAt,
        source: sql.param(values.source, table.source),
        creditBillingMode: sql.param(
          values.creditBillingMode,
          table.creditBillingMode,
        ),
        threadId: sql.param(values.threadId, table.threadId),
        threadContext: sql.param(values.threadContext, table.threadContext),
      },
    ],
    onConflict: sql`(${sql.identifier(table.runId.name)}) DO UPDATE SET
      ${sql.identifier(table.runId.name)} = ${sql.param(conflict.set.runId, table.runId)},
      ${sql.identifier(table.threadId.name)} = ${conflict.set.threadId},
      ${sql.identifier(table.threadContext.name)} = ${conflict.set.threadContext}
      WHERE ${conflict.setWhere}`,
    returning: [{ path: ["runId"], field: table.runId }],
  });
}
