import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentRuns } from "../runtime/agent-run";
import {
  billingRunAttribution,
  type BillingRunTerminalStatus,
} from "../schema/billing-run-attribution";

export function billingRunLifecycleValues(
  status: string,
  completedAt: string | null,
): {
  readonly runTerminalStatus: BillingRunTerminalStatus | null;
  readonly runCompletedAt: SQL | null;
  readonly runLifecycleContext: "captured";
} {
  const terminalStatus =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout"
      ? status
      : null;
  return {
    runTerminalStatus: terminalStatus,
    runCompletedAt:
      terminalStatus === null ? null : sql`${completedAt}::timestamp`,
    runLifecycleContext: "captured",
  };
}

/** A stale in-flight usage write must never erase the winning terminal facts. */
function canCaptureLifecycle() {
  const table = billingRunAttribution;
  return and(
    inArray(table.runLifecycleContext, ["unknown", "captured"]),
    isNull(table.runTerminalStatus),
  );
}

export function billingRunLifecycleConflictSet() {
  const table = billingRunAttribution;
  const canCapture = canCaptureLifecycle();
  return {
    runTerminalStatus: sql`CASE WHEN ${canCapture} THEN excluded.run_terminal_status ELSE ${table.runTerminalStatus} END`,
    runCompletedAt: sql`CASE WHEN ${canCapture} THEN excluded.run_completed_at ELSE ${table.runCompletedAt} END`,
    runLifecycleContext: sql`CASE WHEN ${canCapture} THEN excluded.run_lifecycle_context ELSE ${table.runLifecycleContext} END`,
  };
}

/**
 * The owning terminal transition supplies its winning IDs, status and clock.
 * New admission already owns identity creation. Do not insert a missing legacy
 * identity while holding the Run lock: first usage inserts that identity before
 * acquiring its Run FK lock, so reversing that order can deadlock. Missing or
 * incomplete legacy captures are reconciled before the future reader cutover.
 * Explicit terminal values remain correct inside a data-modifying CTE, whose
 * snapshot still sees the Run's preceding status.
 */
export function captureBillingRunTerminalSql(args: {
  readonly condition: SQL;
  readonly status: BillingRunTerminalStatus;
  readonly completedAt: Date;
}): SQL {
  const table = billingRunAttribution;
  return new PgDialect().buildUpdateQuery({
    table,
    set: {
      runTerminalStatus: sql.param(args.status, table.runTerminalStatus),
      runCompletedAt: sql.param(args.completedAt, table.runCompletedAt),
      runLifecycleContext: sql.param("captured", table.runLifecycleContext),
    },
    from: agentRuns,
    joins: [],
    where: and(
      args.condition,
      eq(table.runId, agentRuns.id),
      eq(table.orgId, agentRuns.orgId),
      eq(table.userId, agentRuns.userId),
      canCaptureLifecycle(),
    ),
    returning: [{ path: ["runId"], field: table.runId }],
  });
}
