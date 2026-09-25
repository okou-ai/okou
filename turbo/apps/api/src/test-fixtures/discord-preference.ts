import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./database-transaction-barrier";

/**
 * Infrastructure exception: HTTP cannot stop after an INSERT has executed but
 * before its transaction checks cancellation. Preserve the real PostgreSQL
 * statement and delay only its result, so the test can prove rollback.
 */
export async function withDiscordDmPreferenceInsertBarrierFixture<T>(
  args: {
    readonly connectionId: string;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return (
          barrierQueryText(queryArgs).startsWith(
            'insert into "discord_user_dm_preferences"',
          ) && barrierQueryBinds(queryArgs, args.connectionId)
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
