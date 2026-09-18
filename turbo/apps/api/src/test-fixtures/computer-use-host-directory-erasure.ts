import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

interface ComputerUseHostDirectoryBarrier extends TransactionBarrier {
  /** Actual statements from the folded first B1 lock through the paused phase. */
  readonly statements: () => readonly string[];
}

function firstHostDirectorySubjectLock(
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

function isHostDirectoryProjection(
  queryArgs: unknown[],
  args: { readonly orgId: string; readonly userId: string },
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_hosts"') &&
    text.includes('"computer_use_hosts"."org_id" =') &&
    text.includes('"computer_use_hosts"."user_id" =') &&
    text.includes('"computer_use_hosts"."revoked_at" is null') &&
    text.includes('order by "computer_use_hosts"."last_seen_at" desc') &&
    barrierQueryBinds(queryArgs, args.orgId) &&
    barrierQueryBinds(queryArgs, args.userId)
  );
}

function projectedHosts(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes('from "computer_use_hosts"') &&
      statement.includes('order by "computer_use_hosts"."last_seen_at" desc')
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
export async function withComputerUseHostDirectoryBarrierFixture<T>(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly stopAt: "commit" | "hosts";
    readonly work: (barrier: ComputerUseHostDirectoryBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  let statements: readonly string[] = [];
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return firstHostDirectorySubjectLock(queryArgs, args.orgId);
      },
      stopAt: (queryArgs, _selectingStatement, transaction) => {
        const text = barrierQueryText(queryArgs);
        const stops =
          args.stopAt === "hosts"
            ? isHostDirectoryProjection(queryArgs, args)
            : text === "commit" && projectedHosts(transaction);
        if (stops) {
          statements = [...transaction.statements, text];
        }
        return stops;
      },
      pauseAfter: args.stopAt === "hosts",
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
