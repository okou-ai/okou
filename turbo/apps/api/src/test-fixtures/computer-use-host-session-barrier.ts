import {
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

/**
 * Infrastructure exception: no API can pause its own transaction between its
 * statements, and the host row lock a session route holds can only be observed
 * from another session while that transaction is still open. Every production
 * statement still executes unchanged and in order; only the result delivery of
 * the first locked host read is delayed, so the lock is held while `work` runs.
 */
export async function withComputerUseHostSessionBarrierFixture<T>(
  work: (barrier: TransactionBarrier) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      pauseAfter: true,
      select: isLockedHostRead,
      stopAt: (_queryArgs, selectingStatement) => {
        return selectingStatement;
      },
      work,
    },
    signal,
  );
}

function isLockedHostRead(queryArgs: unknown[]): boolean {
  const statement = barrierQueryText(queryArgs);
  return (
    statement.startsWith("select") &&
    statement.includes('from "computer_use_hosts"') &&
    / for (no key update|update|key share|share)\b/.test(statement)
  );
}
