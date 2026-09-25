import { createHash } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";

import { writeDb$, type Db } from "../external/db";
import { discordClient } from "../external/discord-client";
import { nowDate } from "../../lib/time";
import {
  discordOrgChangedUserIds,
  publishDiscordChanged,
} from "./discord-realtime.service";

interface DiscordGuildRemoval {
  readonly applicationId: string;
  readonly botToken: string;
  readonly guildId: string;
  readonly eventId: string;
}

type DiscordGuildRemovalOutcome =
  | "accepted"
  | "duplicate"
  | "still-member"
  | "provider-unavailable";

/**
 * GUILD_DELETE carries no event time, and a relay can deliver it late with a
 * fresh eventId (for example after a halt spanning a reinstall). Discord owns
 * guild membership, so a removal applies only while Discord confirms the bot
 * is no longer in the guild.
 */
async function discordGuildMembershipEnded(
  args: DiscordGuildRemoval,
  signal: AbortSignal,
): Promise<"ended" | "still-member" | "provider-unavailable"> {
  const guild = await discordClient.fetchDiscordGuild(
    { botToken: args.botToken, guildId: args.guildId },
    signal,
  );
  signal.throwIfAborted();
  if (guild.kind === "unavailable") {
    return "ended";
  }
  if (guild.kind === "ok" && guild.data.id === args.guildId) {
    return "still-member";
  }
  return "provider-unavailable";
}

async function uninstallDiscordGuild(
  db: Db,
  args: DiscordGuildRemoval,
  signal: AbortSignal,
): Promise<DiscordGuildRemovalOutcome> {
  const eventDigest = createHash("sha256")
    .update(JSON.stringify([args.applicationId, args.eventId]))
    .digest("hex");
  const [seen] = await db
    .select({ eventDigest: discordGatewayReceipts.eventDigest })
    .from(discordGatewayReceipts)
    .where(eq(discordGatewayReceipts.eventDigest, eventDigest))
    .limit(1);
  signal.throwIfAborted();
  if (seen) {
    return "duplicate";
  }
  const membership = await discordGuildMembershipEnded(args, signal);
  if (membership !== "ended") {
    return membership;
  }
  const result = await db.transaction(async (tx) => {
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
    const userIds = await discordOrgChangedUserIds(
      tx,
      installation.orgId,
      connections.map((connection) => {
        return connection.userId;
      }),
    );
    signal.throwIfAborted();
    await tx
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.guildId, args.guildId));
    signal.throwIfAborted();
    return { outcome: "accepted" as const, userIds };
  });
  // Committed changes publish even if the request was cancelled after commit.
  await publishDiscordChanged(result.userIds);
  signal.throwIfAborted();
  return result.outcome;
}

export const uninstallDiscordGuild$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    return await uninstallDiscordGuild(set(writeDb$), args, signal);
  },
);
