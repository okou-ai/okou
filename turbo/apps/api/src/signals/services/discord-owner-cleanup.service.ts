import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../external/db";

/** Remove local authorization only; the bot credential is shared by all guilds. */
export const deleteDiscordOrgMemberData$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, args.userId),
          inArray(
            discordOrgConnections.guildId,
            db
              .select({ guildId: discordOrgInstallations.guildId })
              .from(discordOrgInstallations)
              .where(eq(discordOrgInstallations.orgId, args.orgId)),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

export const deleteDiscordOrgData$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, orgId));
    signal.throwIfAborted();
  },
);

export const deleteDiscordUserData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    // Installer detachment and connection revocation commit together. Preserve
    // the cleanup boundary: observe cancellation after this atomic revocation.
    await set(writeDb$).transaction(async (tx) => {
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
    });
    signal.throwIfAborted();
  },
);
