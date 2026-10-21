import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, exists, gt, isNull, notExists, sql } from "drizzle-orm";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { publishDiscordChanged } from "./discord-realtime.service";
import { notifyDiscordConnection$ } from "./discord-oauth-welcome.service";

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

function connectionOwnerWhere(args: DiscordOauthBindingArgs) {
  return and(
    eq(discordOrgConnections.orgId, args.attempt.orgId),
    eq(discordOrgConnections.userId, args.attempt.userId),
    eq(discordOrgConnections.discordUserId, args.evidence.discordUserId),
  );
}

const resolveConflictedAttempt$ = command(
  async ({ set }, args: DiscordOauthBindingArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const { attempt } = args;
    const db = set(writeDb$);
    // DO NOTHING can observe a winner outside the insertion snapshot. Drop only
    // this already-consumed, unused proof and read that winner in a fresh one.
    const consumed = db.$with("consumed_discord_oauth_conflict").as(
      db
        .delete(discordOauthStates)
        .where(
          and(
            eq(discordOauthStates.id, attempt.id),
            eq(discordOauthStates.userId, attempt.userId),
            eq(discordOauthStates.orgId, attempt.orgId),
            isNull(discordOauthStates.completionTokenHash),
            eq(discordOauthStates.phase, "approved"),
            gt(discordOauthStates.expiresAt, nowDate()),
          ),
        )
        .returning({ id: discordOauthStates.id }),
    );
    const result = await db
      .with(consumed)
      .select({
        attemptId: consumed.id,
        connectionId: discordOrgConnections.id,
      })
      .from(consumed)
      .leftJoin(discordOrgConnections, connectionOwnerWhere(args));
    signal.throwIfAborted();
    return result;
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
    const reconnected = db.$with("reconnected_discord_connection").as(
      db
        .update(discordOrgConnections)
        .set({ oauthGrantId: attempt.id, guildId: null })
        .where(
          and(
            connectionOwnerWhere(args),
            exists(db.select({ id: claimed.id }).from(claimed)),
          ),
        )
        .returning({ id: discordOrgConnections.id }),
    );
    const connection = db.$with("committed_discord_connection").as(
      db
        .insert(discordOrgConnections)
        .select(
          db
            .select(connectionValues(args, createdAt))
            .from(claimed)
            .where(
              notExists(db.select({ id: reconnected.id }).from(reconnected)),
            ),
        )
        // Include the global exclusion constraint in speculative arbitration.
        // A targeted UPSERT leaves it waiting on competing speculative tuples,
        // which can deadlock instead of returning the intended binding conflict.
        .onConflictDoNothing()
        .returning({ id: discordOrgConnections.id }),
    );
    // The organization/user key and global sender ownership reject account
    // replacement. Reconnecting the same owner preserves existing conversations.
    const result = await db
      .with(claimed, reconnected, connection)
      .select({
        attemptId: claimed.id,
        connectionId:
          sql`COALESCE(${reconnected.id}, ${connection.id})`.mapWith(
            nullableDriverValueDecoder(discordOrgConnections.id),
          ),
      })
      .from(claimed)
      .leftJoin(reconnected, sql`true`)
      .leftJoin(connection, sql`true`);
    signal.throwIfAborted();
    return result;
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
    const [claimed] = await set(
      commitDiscordOauthBinding$,
      { ...args, connectionId: proposedConnectionId },
      signal,
    );
    if (!claimed) {
      return "invalid";
    }
    // A conflicting first insert can commit after our statement snapshot. Only
    // the same workspace, owner and verified sender may reuse that winner;
    // a different account or sender remains a conflict.
    const committed = claimed.connectionId
      ? claimed
      : (await set(resolveConflictedAttempt$, args, signal))[0];
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
