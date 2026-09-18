import { connectors } from "@okouai/db/schema/connector";
import { and, eq } from "drizzle-orm";
import { holdDeferredRow } from "./pi-deferred-lock";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

/** Pause the real account writer at COMMIT, after its final cancellation check. */
export async function withConnectorAccountCommitBarrierFixture<T>(
  connectorId: string,
  work: (barrier: TransactionBarrier) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return (
          barrierQueryText(queryArgs).startsWith('update "connectors"') &&
          barrierQueryBinds(queryArgs, connectorId)
        );
      },
      stopAt: (queryArgs) => {
        return barrierQueryText(queryArgs) === "commit";
      },
      work,
    },
    signal,
  );
}

/** Pause an API reconnect at its account row; all resulting state is asserted through routes. */
export async function holdConnectorAccountFixture(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    const [account] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
        ),
      )
      .for("update");
    if (!account) {
      throw new Error("Expected the test-owned builtin connector account");
    }
  });
}
