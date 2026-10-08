import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { and, eq, inArray } from "drizzle-orm";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { releaseUnusedDiscordIdentities } from "./discord-identity-ownership.service";

import type { Db } from "../external/db";

/** Remove local authorization only; the bot credential is shared by all guilds. */
export async function deleteDiscordOrgMemberData(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(discordOauthStates)
      .where(
        and(
          eq(discordOauthStates.userId, args.userId),
          eq(discordOauthStates.orgId, args.orgId),
        ),
      );
    await tx
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, args.userId),
          inArray(
            discordOrgConnections.guildId,
            tx
              .select({ guildId: discordOrgInstallations.guildId })
              .from(discordOrgInstallations)
              .where(eq(discordOrgInstallations.orgId, args.orgId)),
          ),
        ),
      );
    await releaseUnusedDiscordIdentities(tx, [args.userId]);
  });
}

export async function deleteDiscordOrgData(
  db: Db,
  orgId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(discordOauthStates)
      .where(eq(discordOauthStates.orgId, orgId));
    const owners = await tx
      .select({ userId: discordOrgConnections.userId })
      .from(discordOrgConnections)
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(eq(discordOrgInstallations.orgId, orgId));
    await tx
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, orgId));
    await releaseUnusedDiscordIdentities(
      tx,
      owners.map((owner) => {
        return owner.userId;
      }),
    );
  });
}

export async function deleteDiscordUserData(
  db: Db,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(discordOauthStates)
      .where(eq(discordOauthStates.userId, userId));
    // A surviving organization's installation is not the installer's account
    // data. Keep it usable by the remaining members and remove the association.
    await tx
      .update(discordOrgInstallations)
      .set({ installedByUserId: null })
      .where(eq(discordOrgInstallations.installedByUserId, userId));
    // Match guild uninstall: lock installations before their connections.
    // Connections are the enforced parent for routes, ingress, DM selection,
    // and chat context, including accepted ingress not yet attached to a route.
    await tx
      .delete(discordOrgConnections)
      .where(eq(discordOrgConnections.userId, userId));
    await tx
      .delete(discordUserIdentities)
      .where(eq(discordUserIdentities.userId, userId));
  });
}
