import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  connectorOauthStates,
  connectorOauthCompletions,
} from "@okouai/db/schema/connector-oauth-state";
import { asc, inArray, lte } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";

const DELETE_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;

async function cleanupExpiredOAuthRows(
  db: Db,
  table:
    | typeof connectorOauthStates
    | typeof connectorOauthCompletions
    | typeof discordOauthStates,
  args: {
    readonly cutoff: Date;
    readonly batchSize: number;
  },
  signal: AbortSignal,
): Promise<number> {
  const { cutoff, batchSize } = args;
  const expiredWhere = lte(table.expiresAt, cutoff);
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
  batchSize: number,
  signal: AbortSignal,
): Promise<number> {
  const states = await cleanupExpiredOAuthRows(
    db,
    connectorOauthStates,
    { cutoff, batchSize },
    signal,
  );
  const completions = await cleanupExpiredOAuthRows(
    db,
    connectorOauthCompletions,
    { cutoff, batchSize },
    signal,
  );
  const discord = await cleanupExpiredOAuthRows(
    db,
    discordOauthStates,
    { cutoff, batchSize },
    signal,
  );
  return states + completions + discord;
}

export const cleanupConnectorOauthStates$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupConnectorOauthStates(
      set(writeDb$),
      nowDate(),
      DELETE_BATCH_SIZE,
      signal,
    );
  },
);
