import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  lockDiscordIdentities,
  releaseUnusedDiscordIdentities,
} from "./discord-identity-ownership.service";
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
    const installations = await tx
      .select({ guildId: discordOrgInstallations.guildId })
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, args.orgId))
      .orderBy(asc(discordOrgInstallations.guildId))
      .for("update");
    const guildIds = installations.map((installation) => {
      return installation.guildId;
    });
    if (guildIds.length === 0) {
      return;
    }
    const connections = await tx
      .select({ discordUserId: discordOrgConnections.discordUserId })
      .from(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, args.userId),
          inArray(discordOrgConnections.guildId, guildIds),
        ),
      );
    const identities = await lockDiscordIdentities(
      tx,
      connections.map((connection) => {
        return connection.discordUserId;
      }),
    );
    await tx
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, args.userId),
          inArray(discordOrgConnections.guildId, guildIds),
        ),
      );
    await releaseUnusedDiscordIdentities(tx, identities);
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
    const installations = await tx
      .select({ guildId: discordOrgInstallations.guildId })
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, orgId))
      .orderBy(asc(discordOrgInstallations.guildId))
      .for("update");
    const guildIds = installations.map((installation) => {
      return installation.guildId;
    });
    if (guildIds.length === 0) {
      return;
    }
    const connections = await tx
      .select({ discordUserId: discordOrgConnections.discordUserId })
      .from(discordOrgConnections)
      .where(inArray(discordOrgConnections.guildId, guildIds));
    const identities = await lockDiscordIdentities(
      tx,
      connections.map((connection) => {
        return connection.discordUserId;
      }),
    );
    await tx
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, orgId));
    await releaseUnusedDiscordIdentities(tx, identities);
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
    const connectionGuilds = tx
      .select({ guildId: discordOrgConnections.guildId })
      .from(discordOrgConnections)
      .where(eq(discordOrgConnections.userId, userId));
    // Stable installation -> identity -> connection ordering also applies to
    // account cleanup. The surviving org installation is not account data.
    await tx
      .select({ guildId: discordOrgInstallations.guildId })
      .from(discordOrgInstallations)
      .where(
        or(
          inArray(discordOrgInstallations.guildId, connectionGuilds),
          eq(discordOrgInstallations.installedByUserId, userId),
        ),
      )
      .orderBy(asc(discordOrgInstallations.guildId))
      .for("update");
    const owned = await tx
      .select({ discordUserId: discordUserIdentities.discordUserId })
      .from(discordUserIdentities)
      .where(eq(discordUserIdentities.userId, userId));
    const identities = await lockDiscordIdentities(
      tx,
      owned.map((identity) => {
        return identity.discordUserId;
      }),
    );
    await tx
      .update(discordOrgInstallations)
      .set({ installedByUserId: null })
      .where(eq(discordOrgInstallations.installedByUserId, userId));
    await tx
      .delete(discordOrgConnections)
      .where(eq(discordOrgConnections.userId, userId));
    await releaseUnusedDiscordIdentities(tx, identities);
  });
}
