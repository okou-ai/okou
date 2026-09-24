import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserAgentPreferences } from "@okouai/db/schema/discord-user-agent-preference";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";

/** Remove local authorization only; the bot credential is shared by all guilds. */
export async function deleteDiscordOrgMemberData(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
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
    await tx
      .delete(discordUserAgentPreferences)
      .where(
        and(
          eq(discordUserAgentPreferences.userId, args.userId),
          eq(discordUserAgentPreferences.orgId, args.orgId),
        ),
      );
  });
}

export async function deleteDiscordOrgData(
  db: Db,
  orgId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, orgId));
    await tx
      .delete(discordUserAgentPreferences)
      .where(eq(discordUserAgentPreferences.orgId, orgId));
  });
}

export async function deleteDiscordUserData(
  db: Db,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Connections are the enforced parent for routes, ingress, DM selection,
    // and chat context, including accepted ingress not yet attached to a route.
    await tx
      .delete(discordOrgConnections)
      .where(eq(discordOrgConnections.userId, userId));
    await tx
      .delete(discordUserAgentPreferences)
      .where(eq(discordUserAgentPreferences.userId, userId));
    // A surviving organization's installation is not the installer's account
    // data. Keep it usable by the remaining members and remove the association.
    await tx
      .update(discordOrgInstallations)
      .set({ installedByUserId: null })
      .where(eq(discordOrgInstallations.installedByUserId, userId));
  });
}
