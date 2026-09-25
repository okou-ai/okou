import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

/**
 * Infrastructure exception: HTTP cannot pause the Clerk cleanup transaction
 * after removing a user's bindings while retaining its real PostgreSQL locks.
 * This barrier changes no data and preserves the production statements. Its
 * waiter observation proves a concurrent guild uninstall reached those locks.
 */
export async function withDiscordUserCleanupBarrierFixture<T>(
  args: {
    readonly userId: string;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return (
          barrierQueryText(queryArgs).startsWith(
            'delete from "discord_org_connections"',
          ) && barrierQueryBinds(queryArgs, args.userId)
        );
      },
      stopAt: (_queryArgs, selectingStatement) => {
        return selectingStatement;
      },
      pauseAfter: true,
      work: args.work,
    },
    signal,
  );
}
