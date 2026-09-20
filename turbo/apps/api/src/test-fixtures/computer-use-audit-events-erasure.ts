import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

interface ComputerUseAuditEventsBarrier extends TransactionBarrier {
  /** Actual statements from the folded first B1 lock through the paused phase. */
  readonly statements: () => readonly string[];
}

interface AuditEventProjectionIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly commandId?: string;
  readonly hostId?: string;
  readonly runId?: string;
}

function firstAuditEventSubjectLock(
  queryArgs: unknown[],
  orgId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  const lockKey = `account-erasure:${JSON.stringify(["organization", orgId])}`;
  return (
    text.startsWith("select") &&
    text.includes("erasure_isolation_probe") &&
    text.includes("pg_advisory_xact_lock_shared") &&
    barrierQueryBinds(queryArgs, lockKey)
  );
}

function isAuditEventProjection(
  queryArgs: unknown[],
  args: AuditEventProjectionIdentity,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_command_audit_events"') &&
    text.includes('"computer_use_command_audit_events"."org_id" =') &&
    text.includes('"computer_use_command_audit_events"."user_id" =') &&
    text.includes(
      'order by "computer_use_command_audit_events"."created_at" desc',
    ) &&
    text.includes(" limit ") &&
    barrierQueryBinds(queryArgs, args.orgId) &&
    barrierQueryBinds(queryArgs, args.userId) &&
    (!args.commandId || barrierQueryBinds(queryArgs, args.commandId)) &&
    (!args.hostId || barrierQueryBinds(queryArgs, args.hostId)) &&
    (!args.runId || barrierQueryBinds(queryArgs, args.runId))
  );
}

function projectedAuditEvents(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes('from "computer_use_command_audit_events"') &&
      statement.includes(
        'order by "computer_use_command_audit_events"."created_at" desc',
      )
    );
  });
}

/**
 * Infrastructure exception: no API can pause its own transaction after B1 or
 * before COMMIT. The production statements still execute against real
 * PostgreSQL; this fixture delays only the selected statement/result so tests
 * can observe actual lock edges and cancellation ownership from another
 * session.
 */
export async function withComputerUseAuditEventsBarrierFixture<T>(
  args: AuditEventProjectionIdentity & {
    readonly stopAt: "audit-events" | "commit";
    readonly work: (barrier: ComputerUseAuditEventsBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  let statements: readonly string[] = [];
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return firstAuditEventSubjectLock(queryArgs, args.orgId);
      },
      stopAt: (queryArgs, _selectingStatement, transaction) => {
        const text = barrierQueryText(queryArgs);
        const stops =
          args.stopAt === "audit-events"
            ? isAuditEventProjection(queryArgs, args)
            : text === "commit" && projectedAuditEvents(transaction);
        if (stops) {
          statements = [...transaction.statements, text];
        }
        return stops;
      },
      pauseAfter: args.stopAt === "audit-events",
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          statements: () => {
            return statements;
          },
        });
      },
    },
    signal,
  );
}
