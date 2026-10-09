import { computed, type Computed } from "ccstate";
import { connectorOauthCompletions } from "@okouai/db/schema/connector-oauth-state";
import { and, eq, gt } from "drizzle-orm";

import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import { db$, type Db } from "../external/db";

export async function recordConnectorOAuthCompletion(
  db: Db,
  args: {
    readonly attemptId: string;
    readonly connectionId: string;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await db.insert(connectorOauthCompletions).values({
    id: args.attemptId,
    connectionId: args.connectionId,
    orgId: args.orgId,
    userId: args.userId,
    expiresAt: connectorOAuthStateExpiresAt(),
  });
  signal.throwIfAborted();
}

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
