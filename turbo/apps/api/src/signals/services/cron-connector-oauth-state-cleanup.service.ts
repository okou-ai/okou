import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  connectorOauthStates,
  connectorOauthCompletions,
} from "@okouai/db/schema/connector-oauth-state";
import { and, asc, eq, inArray, lte } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";

const DELETE_BATCH_SIZE = 1000;
const TEST_DELETE_BATCH_SIZE = 1;
const MAX_BATCHES = 10;

interface ConnectorOauthStateCleanupOwner {
  readonly userId: string;
  readonly orgId: string;
}

async function cleanupExpiredOAuthRows(
  db: Db,
  table:
    | typeof connectorOauthStates
    | typeof connectorOauthCompletions
    | typeof discordOauthStates,
  args: {
    readonly cutoff: Date;
    readonly owner: ConnectorOauthStateCleanupOwner | undefined;
    readonly batchSize: number;
  },
  signal: AbortSignal,
): Promise<number> {
  const { cutoff, owner, batchSize } = args;
  const expiredWhere = owner
    ? and(
        lte(table.expiresAt, cutoff),
        eq(table.userId, owner.userId),
        eq(table.orgId, owner.orgId),
      )
    : lte(table.expiresAt, cutoff);
  let totalDeleted = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const expiredStates = db
      .select({ id: table.id })
      .from(table)
      .where(expiredWhere)
      .orderBy(asc(table.expiresAt))
      .limit(batchSize);
    const { rowCount } = await db
      .delete(table)
      .where(inArray(table.id, expiredStates));
    signal.throwIfAborted();

    const batchDeleted = rowCount ?? 0;
    totalDeleted += batchDeleted;
    if (batchDeleted < batchSize) {
      break;
    }
  }

  return totalDeleted;
}

async function cleanupConnectorOauthStates(
  db: Db,
  cutoff: Date,
  owner: ConnectorOauthStateCleanupOwner | undefined,
  batchSize: number,
  signal: AbortSignal,
): Promise<number> {
  const states = await cleanupExpiredOAuthRows(
    db,
    connectorOauthStates,
    { cutoff, owner, batchSize },
    signal,
  );
  const completions = await cleanupExpiredOAuthRows(
    db,
    connectorOauthCompletions,
    { cutoff, owner, batchSize },
    signal,
  );
  const discord = await cleanupExpiredOAuthRows(
    db,
    discordOauthStates,
    { cutoff, owner, batchSize },
    signal,
  );
  return states + completions + discord;
}

export const cleanupConnectorOauthStates$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupConnectorOauthStates(
      set(writeDb$),
      nowDate(),
      undefined,
      DELETE_BATCH_SIZE,
      signal,
    );
  },
);

export const cleanupConnectorOauthStatesForTest$ = command(
  async ({ set }, marker: string, signal: AbortSignal): Promise<number> => {
    return await cleanupConnectorOauthStates(
      set(writeDb$),
      nowDate(),
      { userId: marker, orgId: marker },
      TEST_DELETE_BATCH_SIZE,
      signal,
    );
  },
);
