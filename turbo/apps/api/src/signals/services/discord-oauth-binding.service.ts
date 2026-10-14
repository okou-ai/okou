import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
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

function connectionValues(args: DiscordOauthCommitArgs, createdAt: Date) {
  return {
    id: sql`${args.connectionId}`.mapWith(discordOrgConnections.id).as("id"),
    guildId: sql`NULL`
      .mapWith(nullableDriverValueDecoder(discordOrgConnections.guildId))
      .as("guild_id"),
    orgId: sql`${args.attempt.orgId}`
      .mapWith(discordOrgConnections.orgId)
      .as("org_id"),
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

function isBindingConflict(error: unknown): boolean {
  if (
    isUniqueViolation(error, "uq_discord_connections_org_sender") ||
    isUniqueViolation(error, "uq_discord_connections_org_user")
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

/** One statement consumes the personal proof and publishes its account connection. */
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
        }),
    );
    const legacy = db.$with("legacy_discord_connection").as(
      db
        .select({ id: discordOrgConnections.id })
        .from(discordOrgConnections)
        .innerJoin(
          discordOauthStates,
          eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
        )
        .where(
          and(
            isNull(discordOrgConnections.orgId),
            eq(discordOauthStates.orgId, attempt.orgId),
            or(
              eq(discordOrgConnections.userId, attempt.userId),
              eq(
                discordOrgConnections.discordUserId,
                args.evidence.discordUserId,
              ),
            ),
          ),
        ),
    );
    // Adopt connections written by an outgoing API after the migration backfill.
    // Preserve their IDs so queued conversations and preferences retain ownership.
    const adopted = db.$with("adopted_discord_connection").as(
      db
        .update(discordOrgConnections)
        .set({ orgId: attempt.orgId, guildId: null, oauthGrantId: attempt.id })
        .where(
          and(
            isNull(discordOrgConnections.orgId),
            eq(discordOrgConnections.userId, attempt.userId),
            eq(
              discordOrgConnections.discordUserId,
              args.evidence.discordUserId,
            ),
            inArray(
              discordOrgConnections.id,
              db.select({ id: legacy.id }).from(legacy),
            ),
            exists(db.select({ id: claimed.id }).from(claimed)),
          ),
        )
        .returning({ id: discordOrgConnections.id }),
    );
    const connection = db.$with("committed_discord_connection").as(
      db
        .insert(discordOrgConnections)
        // The global exclusion constraint arbitrates active ownership, including
        // rows committed after this statement's snapshot. The grant FK ties the
        // child to the exact consent evidence and makes revocation cascade atomic.
        .select(
          db
            .select(connectionValues(args, createdAt))
            .from(claimed)
            .where(notExists(db.select({ id: legacy.id }).from(legacy))),
        )
        .onConflictDoUpdate({
          target: [
            discordOrgConnections.orgId,
            discordOrgConnections.discordUserId,
          ],
          set: { oauthGrantId: attempt.id, guildId: null },
          setWhere: eq(discordOrgConnections.userId, attempt.userId),
        })
        .returning({ id: discordOrgConnections.id }),
    );
    // The organization/user key and global sender ownership reject account
    // replacement. Reconnecting the same owner preserves existing conversations.
    return await settle(
      db
        .with(claimed, legacy, adopted, connection)
        .select({
          attemptId: claimed.id,
          connectionId: sql`coalesce(${adopted.id}, ${connection.id})`.mapWith(
            nullableDriverValueDecoder(discordOrgConnections.id),
          ),
        })
        .from(claimed)
        .leftJoin(adopted, sql`true`)
        .leftJoin(connection, sql`true`),
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
    await publishDiscordChanged([args.attempt.userId]);
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
