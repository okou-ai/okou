import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  connectorOauthStates,
  connectorOauthCompletions,
} from "@okouai/db/schema/connector-oauth-state";
import { and, asc, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const DELETE_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;

const cleanupExpiredOAuthRows$ = command(
  async (
    { set },
    table:
      | typeof connectorOauthStates
      | typeof connectorOauthCompletions
      | typeof discordOauthStates
      | typeof discordOrgGrants,
    args: {
      readonly cutoff: Date;
      readonly batchSize: number;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const { cutoff, batchSize } = args;
    const expiredWhere = and(
      lte(table.expiresAt, cutoff),
      table === discordOauthStates
        ? isNotNull(discordOauthStates.completionTokenHash)
        : undefined,
      table === discordOrgGrants
        ? isNull(discordOrgGrants.approvedAt)
        : undefined,
    );
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
  },
);

export const cleanupConnectorOauthStates$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const args = { cutoff: nowDate(), batchSize: DELETE_BATCH_SIZE };
    const states = await set(
      cleanupExpiredOAuthRows$,
      connectorOauthStates,
      args,
      signal,
    );
    const completions = await set(
      cleanupExpiredOAuthRows$,
      connectorOauthCompletions,
      args,
      signal,
    );
    const discord = await set(
      cleanupExpiredOAuthRows$,
      discordOauthStates,
      args,
      signal,
    );
    const installationConsents = await set(
      cleanupExpiredOAuthRows$,
      discordOrgGrants,
      args,
      signal,
    );
    return states + completions + discord + installationConsents;
  },
);
