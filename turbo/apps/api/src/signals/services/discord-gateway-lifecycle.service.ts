import { createHash } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  discordCleanupRecipients,
  discordRemovalProjection,
  publishDiscordChanged,
} from "./discord-realtime.service";

interface DiscordGuildRemoval {
  readonly applicationId: string;
  readonly guildId: string;
  readonly eventId: string;
}

const commitDiscordGuildRemoval$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const eventDigest = createHash("sha256")
      .update(JSON.stringify([args.applicationId, args.eventId]))
      .digest("hex");
    const receipt = db
      .$with("claimed_discord_guild_removal")
      .as(
        db
          .insert(discordGatewayReceipts)
          .values({ eventDigest, createdAt: nowDate() })
          .onConflictDoNothing()
          .returning({ eventDigest: discordGatewayReceipts.eventDigest }),
      );
    const revoked = db.$with("revoked_discord_guild_member_grants").as(
      db
        .delete(discordOauthStates)
        .where(
          and(
            or(
              eq(discordOauthStates.guildId, args.guildId),
              eq(discordOauthStates.verifiedGuildId, args.guildId),
            ),
            exists(db.select({ id: receipt.eventDigest }).from(receipt)),
          ),
        )
        .returning({
          userId: discordOauthStates.userId,
          completionTokenHash: discordOauthStates.completionTokenHash,
        }),
    );
    const consents = db.$with("revoked_discord_guild_installation_grants").as(
      db
        .delete(discordOrgGrants)
        .where(
          and(
            or(
              eq(discordOrgGrants.requestedGuildId, args.guildId),
              eq(discordOrgGrants.verifiedGuildId, args.guildId),
            ),
            exists(db.select({ id: receipt.eventDigest }).from(receipt)),
            gte(db.select({ count: count() }).from(revoked), 0),
          ),
        )
        .returning({
          orgId: discordOrgGrants.orgId,
          approvedAt: discordOrgGrants.approvedAt,
        }),
    );
    const legacy = db.$with("revoked_legacy_discord_guild").as(
      db
        .delete(discordOrgInstallations)
        .where(
          and(
            eq(discordOrgInstallations.guildId, args.guildId),
            isNull(discordOrgInstallations.orgGrantId),
            exists(db.select({ id: receipt.eventDigest }).from(receipt)),
            gte(db.select({ count: count() }).from(consents), 0),
          ),
        )
        .returning({
          guildId: discordOrgInstallations.guildId,
          orgId: discordOrgInstallations.orgId,
        }),
    );
    const removed = db.$with("removed_discord_gateway_guild").as(
      db
        .select({ orgId: consents.orgId })
        .from(consents)
        .where(isNotNull(consents.approvedAt))
        .unionAll(db.select({ orgId: legacy.orgId }).from(legacy)),
    );
    const hasRemoval = exists(
      db.select({ orgId: removed.orgId }).from(removed),
    );
    const admins = db
      .select(discordRemovalProjection(sql`${orgMembersCache.userId}`, true))
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.role, "admin"),
          inArray(
            orgMembersCache.orgId,
            db.select({ orgId: removed.orgId }).from(removed),
          ),
        ),
      );
    const connections = db
      .select(
        discordRemovalProjection(sql`${discordOrgConnections.userId}`, true),
      )
      .from(discordOrgConnections)
      .where(and(eq(discordOrgConnections.guildId, args.guildId), hasRemoval));
    const grantOwners = db
      .select(discordRemovalProjection(sql`${revoked.userId}`, true))
      .from(revoked)
      .where(and(isNull(revoked.completionTokenHash), hasRemoval));
    const recipients = db.$with("discord_gateway_cleanup_recipients").as(
      db
        .select(discordRemovalProjection(sql`NULL`, false))
        .from(receipt)
        .unionAll(admins)
        .unionAll(connections)
        .unionAll(grantOwners),
    );
    return await db
      .with(receipt, revoked, consents, legacy, removed, recipients)
      .select({ removed: recipients.removed, userId: recipients.userId })
      .from(recipients);
  },
);

export const uninstallDiscordGuild$ = command(
  async ({ set }, args: DiscordGuildRemoval, signal: AbortSignal) => {
    const rows = await set(commitDiscordGuildRemoval$, args, signal);
    const recipients = discordCleanupRecipients(rows, []);
    await publishDiscordChanged(recipients.userIds);
    signal.throwIfAborted();
    return rows.length > 0 ? ("accepted" as const) : ("duplicate" as const);
  },
);
