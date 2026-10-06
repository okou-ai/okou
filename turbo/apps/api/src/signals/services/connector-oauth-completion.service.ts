import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorOauthCompletions } from "@okouai/db/schema/connector-oauth-state";
import { and, eq, gt } from "drizzle-orm";

import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { getConnectorAccount } from "./connector-account-lifecycle.service";

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

export async function readConnectorOAuthCompletion(
  db: Db,
  args: {
    readonly attemptId: string;
    readonly target: ConnectorAccountTarget;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<{ readonly connectionId: string } | null> {
  const [receipt] = await db
    .select({ connectionId: connectorOauthCompletions.connectionId })
    .from(connectorOauthCompletions)
    .where(
      and(
        eq(connectorOauthCompletions.id, args.attemptId),
        eq(connectorOauthCompletions.orgId, args.orgId),
        eq(connectorOauthCompletions.userId, args.userId),
        gt(connectorOauthCompletions.expiresAt, nowDate()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!receipt) {
    return null;
  }
  const account = await getConnectorAccount(db, {
    orgId: args.orgId,
    userId: args.userId,
    target: args.target,
    connectionId: receipt.connectionId,
  });
  signal.throwIfAborted();
  return account ? receipt : null;
}
