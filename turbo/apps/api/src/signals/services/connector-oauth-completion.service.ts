import { command, computed, type Computed } from "ccstate";
import { connectorOauthCompletions } from "@okouai/db/schema/connector-oauth-state";
import { and, eq, gt } from "drizzle-orm";

import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

export const recordConnectorOAuthCompletion$ = command(
  async (
    { set },
    args: {
      readonly attemptId: string;
      readonly connectionId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { attemptId, connectionId, orgId, userId } = args;
    signal.throwIfAborted();
    // Return committed receipts so the callback can notify its owner before
    // observing cancellation that occurred during the write.
    await set(writeDb$).insert(connectorOauthCompletions).values({
      id: attemptId,
      connectionId,
      orgId,
      userId,
      expiresAt: connectorOAuthStateExpiresAt(),
    });
  },
);

export function connectorOAuthCompletionReceipt(
  scope$: Computed<{
    readonly attemptId: string;
    readonly orgId: string;
    readonly userId: string;
  }>,
) {
  return computed(
    async (get): Promise<{ readonly connectionId: string } | null> => {
      const { attemptId, orgId, userId } = get(scope$);
      const [receipt] = await get(db$)
        .select({ connectionId: connectorOauthCompletions.connectionId })
        .from(connectorOauthCompletions)
        .where(
          and(
            eq(connectorOauthCompletions.id, attemptId),
            eq(connectorOauthCompletions.orgId, orgId),
            eq(connectorOauthCompletions.userId, userId),
            gt(connectorOauthCompletions.expiresAt, nowDate()),
          ),
        )
        .limit(1);
      return receipt ?? null;
    },
  );
}
