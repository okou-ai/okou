import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  discordIdentityOwnersWhere,
  unusedDiscordIdentityOwnersWhere,
} from "./discord-identity-ownership.service";
import { writeDb$ } from "../external/db";

/** Remove local authorization only; the bot credential is shared by all guilds. */
export const deleteDiscordOrgMemberData$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    // Pending proofs, member connections and unused identity parents revoke atomically.
    await set(writeDb$).transaction(async (tx) => {
      await tx
        .delete(discordOauthStates)
        .where(
          and(
            eq(discordOauthStates.userId, args.userId),
            eq(discordOauthStates.orgId, args.orgId),
          ),
        );
      signal.throwIfAborted();
      const installations = await tx
        .select({ guildId: discordOrgInstallations.guildId })
        .from(discordOrgInstallations)
        .where(eq(discordOrgInstallations.orgId, args.orgId))
        .orderBy(asc(discordOrgInstallations.guildId))
        .for("update");
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      const identities = await tx
        .select({ discordUserId: discordUserIdentities.discordUserId })
        .from(discordUserIdentities)
        .where(
          discordIdentityOwnersWhere(
            connections.map((connection) => {
              return connection.discordUserId;
            }),
          ),
        )
        .orderBy(asc(discordUserIdentities.discordUserId))
        .for("update");
      signal.throwIfAborted();
      await tx
        .delete(discordOrgConnections)
        .where(
          and(
            eq(discordOrgConnections.userId, args.userId),
            inArray(discordOrgConnections.guildId, guildIds),
          ),
        );
      signal.throwIfAborted();
      await tx
        .delete(discordUserIdentities)
        .where(unusedDiscordIdentityOwnersWhere(identities));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

export const deleteDiscordOrgData$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    // Guild removal, proof cancellation and unused-parent release must commit together.
    await set(writeDb$).transaction(async (tx) => {
      await tx
        .delete(discordOauthStates)
        .where(eq(discordOauthStates.orgId, orgId));
      signal.throwIfAborted();
      const installations = await tx
        .select({ guildId: discordOrgInstallations.guildId })
        .from(discordOrgInstallations)
        .where(eq(discordOrgInstallations.orgId, orgId))
        .orderBy(asc(discordOrgInstallations.guildId))
        .for("update");
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      const identities = await tx
        .select({ discordUserId: discordUserIdentities.discordUserId })
        .from(discordUserIdentities)
        .where(
          discordIdentityOwnersWhere(
            connections.map((connection) => {
              return connection.discordUserId;
            }),
          ),
        )
        .orderBy(asc(discordUserIdentities.discordUserId))
        .for("update");
      signal.throwIfAborted();
      await tx
        .delete(discordOrgInstallations)
        .where(eq(discordOrgInstallations.orgId, orgId));
      signal.throwIfAborted();
      await tx
        .delete(discordUserIdentities)
        .where(unusedDiscordIdentityOwnersWhere(identities));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

export const deleteDiscordUserData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    // Account proof/connection revocation and identity release have one transaction owner.
    await set(writeDb$).transaction(async (tx) => {
      await tx
        .delete(discordOauthStates)
        .where(eq(discordOauthStates.userId, userId));
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      const owned = await tx
        .select({ discordUserId: discordUserIdentities.discordUserId })
        .from(discordUserIdentities)
        .where(eq(discordUserIdentities.userId, userId));
      signal.throwIfAborted();
      const identities = await tx
        .select({ discordUserId: discordUserIdentities.discordUserId })
        .from(discordUserIdentities)
        .where(
          discordIdentityOwnersWhere(
            owned.map((identity) => {
              return identity.discordUserId;
            }),
          ),
        )
        .orderBy(asc(discordUserIdentities.discordUserId))
        .for("update");
      signal.throwIfAborted();
      await tx
        .update(discordOrgInstallations)
        .set({ installedByUserId: null })
        .where(eq(discordOrgInstallations.installedByUserId, userId));
      signal.throwIfAborted();
      await tx
        .delete(discordOrgConnections)
        .where(eq(discordOrgConnections.userId, userId));
      signal.throwIfAborted();
      await tx
        .delete(discordUserIdentities)
        .where(unusedDiscordIdentityOwnersWhere(identities));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
