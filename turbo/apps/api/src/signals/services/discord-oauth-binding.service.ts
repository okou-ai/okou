import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, gt, sql } from "drizzle-orm";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { publishDiscordChanged } from "./discord-realtime.service";
import { notifyDiscordConnection$ } from "./discord-oauth-welcome.service";
import { settle } from "../utils";

export type DiscordOauthAttempt = typeof discordOauthStates.$inferSelect;
export interface DiscordOauthEvidence {
  readonly guildId: string;
  readonly guildName: string;
  readonly discordUserId: string;
  readonly botUserId: string;
}
interface DiscordOauthBindingArgs {
  readonly attempt: DiscordOauthAttempt;
  readonly evidence: DiscordOauthEvidence;
}
interface DiscordOauthCommitArgs extends DiscordOauthBindingArgs {
  readonly connectionId: string;
}

function approvedAttemptWhere(attempt: DiscordOauthAttempt) {
  return and(
    eq(discordOauthStates.id, attempt.id),
    eq(discordOauthStates.userId, attempt.userId),
    eq(discordOauthStates.orgId, attempt.orgId),
    eq(
      discordOauthStates.completionTokenHash,
      sql`${attempt.completionTokenHash}`,
    ),
    eq(discordOauthStates.phase, "approved"),
  );
}

function installationValues(args: DiscordOauthBindingArgs, createdAt: Date) {
  const { attempt, evidence } = args;
  return {
    guildId: sql`${evidence.guildId}`
      .mapWith(discordOrgInstallations.guildId)
      .as("guild_id"),
    guildName: sql`${evidence.guildName}`
      .mapWith(discordOrgInstallations.guildName)
      .as("guild_name"),
    orgId: sql`${attempt.orgId}`
      .mapWith(discordOrgInstallations.orgId)
      .as("org_id"),
    botUserId: sql`${evidence.botUserId}`
      .mapWith(discordOrgInstallations.botUserId)
      .as("bot_user_id"),
    installedByUserId: sql`${attempt.userId}`
      .mapWith(discordOrgInstallations.installedByUserId)
      .as("installed_by_user_id"),
    orgGrantId: sql`${attempt.id}`
      .mapWith(discordOrgInstallations.orgGrantId)
      .as("org_grant_id"),
    createdAt: sql`${sql.param(createdAt, discordOrgInstallations.createdAt)}`
      .mapWith(discordOrgInstallations.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(createdAt, discordOrgInstallations.updatedAt)}`
      .mapWith(discordOrgInstallations.updatedAt)
      .as("updated_at"),
  };
}

function connectionValues(args: DiscordOauthCommitArgs, createdAt: Date) {
  return {
    id: sql`${args.connectionId}`.mapWith(discordOrgConnections.id).as("id"),
    guildId: sql`${args.evidence.guildId}`
      .mapWith(discordOrgConnections.guildId)
      .as("guild_id"),
    discordUserId: sql`${args.evidence.discordUserId}`
      .mapWith(discordOrgConnections.discordUserId)
      .as("discord_user_id"),
    userId: sql`${args.attempt.userId}`
      .mapWith(discordOrgConnections.userId)
      .as("user_id"),
    oauthGrantId: sql`${args.attempt.id}`
      .mapWith(discordOrgConnections.oauthGrantId)
      .as("oauth_grant_id"),
    createdAt: sql`${sql.param(createdAt, discordOrgConnections.createdAt)}`
      .mapWith(discordOrgConnections.createdAt)
      .as("created_at"),
  };
}

function installationAuthorityWhere(args: DiscordOauthBindingArgs) {
  return and(
    eq(discordOrgInstallations.orgId, args.attempt.orgId),
    eq(discordOrgInstallations.botUserId, args.evidence.botUserId),
  );
}

function existingInstallationWhere(args: DiscordOauthBindingArgs) {
  return and(
    eq(discordOrgInstallations.guildId, args.evidence.guildId),
    installationAuthorityWhere(args),
  );
}

function installationConsentEvidenceWhere(args: DiscordOauthBindingArgs) {
  return and(
    eq(discordOrgGrants.orgId, args.attempt.orgId),
    eq(discordOrgGrants.initiatedByUserId, args.attempt.userId),
    eq(discordOrgGrants.verifiedGuildId, args.evidence.guildId),
    eq(discordOrgGrants.verifiedBotUserId, args.evidence.botUserId),
  );
}

function installationAdminsWhere(orgId: string) {
  return and(
    eq(orgMembersCache.orgId, orgId),
    eq(orgMembersCache.role, "admin"),
  );
}

function isBindingConflict(error: unknown): boolean {
  if (
    isUniqueViolation(error, "uq_discord_org_installations_org") ||
    isUniqueViolation(error, "uq_discord_org_connections_guild_user")
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === "23P01" &&
    "constraint" in error.cause &&
    error.cause.constraint === "ex_discord_connections_global_sender_owner"
  );
}

const consumeConflictedAttempt$ = command(
  async (
    { set },
    attempt: DiscordOauthAttempt,
    signal: AbortSignal,
  ): Promise<void> => {
    // An exact constraint failure rolls back the entire statement. Consume only
    // this owned proof, matching the existing non-replayable conflict outcome.
    await set(writeDb$)
      .delete(discordOauthStates)
      .where(approvedAttemptWhere(attempt));
    signal.throwIfAborted();
  },
);

/** One statement owns proof consumption, parent authority and the binding. */
const commitDiscordOauthBinding$ = command(
  async ({ set }, args: DiscordOauthCommitArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const { attempt } = args;
    const createdAt = nowDate();
    const db = set(writeDb$);
    const claimed = db.$with("claimed_discord_oauth").as(
      db
        .update(discordOauthStates)
        .set({ completionTokenHash: null })
        .where(
          and(
            approvedAttemptWhere(attempt),
            gt(discordOauthStates.expiresAt, createdAt),
          ),
        )
        .returning({
          id: discordOauthStates.id,
          flow: discordOauthStates.flow,
        }),
    );
    const installationConsent = db
      .$with("eligible_discord_installation_consent")
      .as(
        db
          .select({ id: discordOrgGrants.id })
          .from(discordOrgGrants)
          .where(
            and(
              eq(
                discordOrgGrants.id,
                db
                  .select({ id: claimed.id })
                  .from(claimed)
                  .where(eq(claimed.flow, "install")),
              ),
              installationConsentEvidenceWhere(args),
            ),
          ),
      );
    const installed = db.$with("installed_discord_guild").as(
      db
        .insert(discordOrgInstallations)
        .select(
          db
            .select(installationValues(args, createdAt))
            .from(installationConsent),
        )
        .onConflictDoUpdate({
          target: discordOrgInstallations.guildId,
          // RETURNING owns both a new parent and a same-owner incumbent; a base
          // table SELECT cannot see sibling CTE inserts or a waited-on winner.
          set: { guildName: discordOrgInstallations.guildName },
          setWhere: installationAuthorityWhere(args),
        })
        .returning({
          guildId: discordOrgInstallations.guildId,
          orgGrantId: discordOrgInstallations.orgGrantId,
        }),
    );
    // Only a returned new installation activates this organization consent.
    // Immediate FK checks run at statement end, after these dependent CTEs.
    const approvedGrant = db.$with("approved_discord_installation_consent").as(
      db
        .update(discordOrgGrants)
        .set({ approvedAt: createdAt })
        .where(
          eq(
            discordOrgGrants.id,
            db
              .select({ id: installed.orgGrantId })
              .from(installed)
              .where(eq(installed.orgGrantId, attempt.id)),
          ),
        )
        .returning({ id: discordOrgGrants.id }),
    );
    const existing = db
      .$with("connected_discord_guild")
      .as(
        db
          .select({ guildId: discordOrgInstallations.guildId })
          .from(discordOrgInstallations)
          .innerJoin(claimed, eq(claimed.flow, "connect"))
          .where(existingInstallationWhere(args))
          .for("share", { of: discordOrgInstallations }),
      );
    const installation = db.$with("authorized_discord_guild").as(
      db
        .select({ guildId: installed.guildId })
        .from(installed)
        .unionAll(db.select({ guildId: existing.guildId }).from(existing)),
    );
    const connection = db.$with("committed_discord_connection").as(
      db
        .insert(discordOrgConnections)
        // The global exclusion constraint arbitrates active ownership, including
        // rows committed after this statement's snapshot. The grant FK ties the
        // child to the exact consent evidence and makes revocation cascade atomic.
        .select(db.select(connectionValues(args, createdAt)).from(installation))
        .onConflictDoUpdate({
          target: [
            discordOrgConnections.guildId,
            discordOrgConnections.discordUserId,
          ],
          set: { oauthGrantId: attempt.id },
          setWhere: eq(discordOrgConnections.userId, attempt.userId),
        })
        .returning({ id: discordOrgConnections.id }),
    );
    // A different sender for this guild/user hits the other real unique key and
    // rolls back, instead of reserving a guild or transferring sender ownership.
    // Capture the settled commit before any post-commit cancellation check.
    return await settle(
      db
        .with(
          claimed,
          installationConsent,
          installed,
          approvedGrant,
          existing,
          installation,
          connection,
        )
        .select({
          attemptId: claimed.id,
          connectionId: connection.id,
          adminUserId: orgMembersCache.userId,
        })
        .from(claimed)
        .leftJoin(connection, sql`true`)
        .leftJoin(orgMembersCache, installationAdminsWhere(attempt.orgId)),
    );
  },
);

/** No callback or approval grants access; publish only committed binding facts. */
export const persistDiscordOauth$ = command(
  async (
    { set },
    args: DiscordOauthBindingArgs,
    signal: AbortSignal,
  ): Promise<"saved" | "conflict" | "invalid"> => {
    const proposedConnectionId = randomUUID();
    const result = await set(
      commitDiscordOauthBinding$,
      { ...args, connectionId: proposedConnectionId },
      signal,
    );
    if (!result.ok) {
      signal.throwIfAborted();
      if (!isBindingConflict(result.error)) {
        throw result.error;
      }
      await set(consumeConflictedAttempt$, args.attempt, signal);
      return "conflict";
    }
    const committed = result.value[0];
    if (!committed || !committed.connectionId) {
      signal.throwIfAborted();
      return committed ? "conflict" : "invalid";
    }
    const recipients = new Set([args.attempt.userId]);
    for (const row of result.value) {
      if (row.adminUserId !== null) {
        recipients.add(row.adminUserId);
      }
    }
    await publishDiscordChanged([...recipients]);
    signal.throwIfAborted();
    if (committed.connectionId === proposedConnectionId) {
      await set(
        notifyDiscordConnection$,
        {
          connectionId: committed.connectionId,
          orgId: args.attempt.orgId,
          userId: args.attempt.userId,
        },
        signal,
      );
    }
    return "saved";
  },
);
