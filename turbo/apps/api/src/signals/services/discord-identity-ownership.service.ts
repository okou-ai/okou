import { and, eq, inArray, notExists } from "drizzle-orm";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import type { Tx } from "../../lib/db-types";

/** Release ownership only after the last guild binding has been removed. */
export async function releaseUnusedDiscordIdentities(
  tx: Tx,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }
  await tx
    .delete(discordUserIdentities)
    .where(
      and(
        inArray(discordUserIdentities.userId, [...new Set(userIds)]),
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
