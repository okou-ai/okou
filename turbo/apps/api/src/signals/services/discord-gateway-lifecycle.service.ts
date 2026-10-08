import { createHash } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  discordOrgAdminsWhere,
  discordChangedUserIds,
  publishDiscordChanged,
} from "./discord-realtime.service";

interface DiscordGuildRemoval {
  readonly applicationId: string;
  readonly guildId: string;
  readonly eventId: string;
}

const commitDiscordGuildRemoval$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    const eventDigest = createHash("sha256")
      .update(JSON.stringify([args.applicationId, args.eventId]))
      .digest("hex");
    // The receipt and guild revocation commit together, with recipients captured
    // before cascades and the installation locked before its connections.
    return await set(writeDb$).transaction(async (tx) => {
      const [receipt] = await tx
        .insert(discordGatewayReceipts)
        .values({ eventDigest, createdAt: nowDate() })
        .onConflictDoNothing()
        .returning({ eventDigest: discordGatewayReceipts.eventDigest });
      signal.throwIfAborted();
      if (!receipt) {
        return { outcome: "duplicate" as const, userIds: [] };
      }
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
        .select({ userId: discordOrgConnections.userId })
        .from(discordOrgConnections)
        .where(eq(discordOrgConnections.guildId, args.guildId));
      signal.throwIfAborted();
      const admins = await tx
        .select({ userId: orgMembersCache.userId })
        .from(orgMembersCache)
        .where(discordOrgAdminsWhere(installation.orgId));
      signal.throwIfAborted();
      const userIds = discordChangedUserIds(
        admins.map((admin) => {
          return admin.userId;
        }),
        connections.map((connection) => {
          return connection.userId;
        }),
      );
      await tx
        .delete(discordOrgInstallations)
        .where(eq(discordOrgInstallations.guildId, args.guildId));
      signal.throwIfAborted();
      return { outcome: "accepted" as const, userIds };
    });
  },
);

export const uninstallDiscordGuild$ = command(
  async (
    { set },
    args: DiscordGuildRemoval,
    signal: AbortSignal,
  ): Promise<"accepted" | "duplicate"> => {
    const result = await set(commitDiscordGuildRemoval$, args, signal);
    // Committed changes publish even if the request was cancelled after commit.
    await publishDiscordChanged(result.userIds);
    signal.throwIfAborted();
    return result.outcome;
  },
);
