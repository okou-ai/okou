import { and, asc, eq, inArray, notExists } from "drizzle-orm";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import type { Tx } from "../../lib/db-types";

export interface LockedDiscordIdentities {
  readonly discordUserIds: readonly string[];
}

/** All writers lock installation(s), then identity parents, then connections. */
export async function lockDiscordIdentities(
  tx: Tx,
  discordUserIds: readonly string[],
): Promise<LockedDiscordIdentities> {
  if (discordUserIds.length === 0) {
    return { discordUserIds: [] };
  }
  const rows = await tx
    .select({ discordUserId: discordUserIdentities.discordUserId })
    .from(discordUserIdentities)
    .where(
      inArray(discordUserIdentities.discordUserId, [
        ...new Set(discordUserIds),
      ]),
    )
    .orderBy(asc(discordUserIdentities.discordUserId))
    .for("update");
  return {
    discordUserIds: rows.map((row) => {
      return row.discordUserId;
    }),
  };
}

/** A FRESH statement after parent-lock acquisition sees a waited-for new child. */
export async function releaseUnusedDiscordIdentities(
  tx: Tx,
  locked: LockedDiscordIdentities,
): Promise<void> {
  if (locked.discordUserIds.length === 0) {
    return;
  }
  await tx
    .delete(discordUserIdentities)
    .where(
      and(
        inArray(discordUserIdentities.discordUserId, [
          ...locked.discordUserIds,
        ]),
        notExists(
          tx
            .select({ id: discordOrgConnections.id })
            .from(discordOrgConnections)
            .where(
              eq(
                discordOrgConnections.discordUserId,
                discordUserIdentities.discordUserId,
              ),
            ),
        ),
      ),
    );
}
