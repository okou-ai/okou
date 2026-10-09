import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, or } from "drizzle-orm";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  discordIdentityOwnersWhere,
  unusedDiscordIdentityOwnersWhere,
} from "./discord-identity-ownership.service";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";

import { writeDb$ } from "../external/db";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { nowDate } from "../../lib/time";
import {
  discordOrgChangedUserIds,
  publishDiscordChanged,
} from "./discord-realtime.service";

interface DiscordGuildRemoval {
  readonly applicationId: string;
  readonly guildId: string;
  readonly eventId: string;
}

const commitDiscordGuildRemoval$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    const db = set(writeDb$);
    const eventDigest = createHash("sha256")
      .update(JSON.stringify([args.applicationId, args.eventId]))
      .digest("hex");
    // The replay receipt and guild/identity revocation must commit together.
    return await db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(discordGatewayReceipts)
        .values({ eventDigest, createdAt: nowDate() })
        .onConflictDoNothing()
        .returning({ eventDigest: discordGatewayReceipts.eventDigest });
      signal.throwIfAborted();
      if (!receipt) {
        return { outcome: "duplicate" as const, userIds: [] };
      }
      await tx
        .delete(discordOauthStates)
        .where(
          or(
            eq(discordOauthStates.guildId, args.guildId),
            eq(discordOauthStates.verifiedGuildId, args.guildId),
          ),
        );
      signal.throwIfAborted();
      const [installation] = await tx
        .select({ orgId: discordOrgInstallations.orgId })
        .from(discordOrgInstallations)
        .where(eq(discordOrgInstallations.guildId, args.guildId))
        .for("update");
      signal.throwIfAborted();
      if (!installation) {
        return { outcome: "accepted" as const, userIds: [] };
      }
      const connections = await tx
        .select({
          userId: discordOrgConnections.userId,
          discordUserId: discordOrgConnections.discordUserId,
        })
        .from(discordOrgConnections)
        .where(eq(discordOrgConnections.guildId, args.guildId));
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
      const admins = await tx
        .select({ userId: orgMembersCache.userId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, installation.orgId),
            eq(orgMembersCache.role, "admin"),
          ),
        );
      const userIds = discordOrgChangedUserIds(
        admins,
        connections.map((connection) => {
          return connection.userId;
        }),
      );
      signal.throwIfAborted();
      await tx
        .delete(discordOrgInstallations)
        .where(eq(discordOrgInstallations.guildId, args.guildId));
      signal.throwIfAborted();
      await tx
        .delete(discordUserIdentities)
        .where(unusedDiscordIdentityOwnersWhere(identities));
      signal.throwIfAborted();
      return { outcome: "accepted" as const, userIds };
    });
  },
);

export const uninstallDiscordGuild$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    const result = await set(commitDiscordGuildRemoval$, args, signal);
    // Committed changes publish before observing a post-commit cancellation.
    await publishDiscordChanged(result.userIds);
    signal.throwIfAborted();
    return result.outcome;
  },
);
