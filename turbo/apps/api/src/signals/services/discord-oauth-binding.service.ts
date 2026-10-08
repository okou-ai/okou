import { command } from "ccstate";
import { and, eq, gt } from "drizzle-orm";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import { writeDb$, type Db } from "../external/db";
import {
  discordOrgChangedUserIds,
  publishDiscordChanged,
} from "./discord-realtime.service";
import { notifyDiscordConnection$ } from "./discord-oauth-welcome.service";
import { settle } from "../utils";

export type DiscordOauthAttempt = typeof discordOauthStates.$inferSelect;
export interface DiscordOauthEvidence {
  readonly guildId: string;
  readonly guildName: string;
  readonly discordUserId: string;
  readonly botUserId: string;
}
class BindingConflict extends Error {
  constructor() {
    super("Discord binding conflict");
  }
}
class InvalidAttempt extends Error {
  constructor() {
    super("Discord OAuth attempt is no longer available");
  }
}

async function claimCompletion(
  tx: Tx,
  attempt: DiscordOauthAttempt,
  signal: AbortSignal,
): Promise<void> {
  const [claimed] = await tx
    .delete(discordOauthStates)
    .where(
      and(
        eq(discordOauthStates.id, attempt.id),
        eq(discordOauthStates.userId, attempt.userId),
        eq(discordOauthStates.orgId, attempt.orgId),
        eq(discordOauthStates.completionTokenHash, attempt.completionTokenHash),
        eq(discordOauthStates.phase, "approved"),
        gt(discordOauthStates.expiresAt, nowDate()),
      ),
    )
    .returning({ id: discordOauthStates.id });
  signal.throwIfAborted();
  if (!claimed) {
    throw new InvalidAttempt();
  }
}

async function consumeConflictedAttempt(
  db: Db,
  attempt: DiscordOauthAttempt,
  signal: AbortSignal,
): Promise<void> {
  // The failed binding transaction rolled back completely. Consume this exact
  // owned proof so a conflict cannot be replayed as a later install.
  await db
    .delete(discordOauthStates)
    .where(
      and(
        eq(discordOauthStates.id, attempt.id),
        eq(discordOauthStates.userId, attempt.userId),
        eq(discordOauthStates.orgId, attempt.orgId),
        eq(discordOauthStates.completionTokenHash, attempt.completionTokenHash),
        eq(discordOauthStates.phase, "approved"),
      ),
    );
  signal.throwIfAborted();
}

/** Claim and final binding commit together; no callback or approval grants access. */
export const persistDiscordOauth$ = command(
  async (
    { set },
    args: {
      readonly attempt: DiscordOauthAttempt;
      readonly evidence: DiscordOauthEvidence;
    },
    signal: AbortSignal,
  ): Promise<"saved" | "conflict" | "invalid"> => {
    const { attempt, evidence } = args;
    const db = set(writeDb$);
    const result = await settle(
      db.transaction(async (tx) => {
        await claimCompletion(tx, attempt, signal);
        if (attempt.flow === "install") {
          await tx
            .insert(discordOrgInstallations)
            .values({
              guildId: evidence.guildId,
              guildName: evidence.guildName,
              orgId: attempt.orgId,
              botUserId: evidence.botUserId,
              installedByUserId: attempt.userId,
              createdAt: nowDate(),
              updatedAt: nowDate(),
            })
            .onConflictDoNothing();
          signal.throwIfAborted();
        }
        const [installation] = await tx
          .select()
          .from(discordOrgInstallations)
          .where(
            and(
              eq(discordOrgInstallations.guildId, evidence.guildId),
              eq(discordOrgInstallations.orgId, attempt.orgId),
            ),
          )
          .for("share");
        signal.throwIfAborted();
        if (!installation || installation.botUserId !== evidence.botUserId) {
          throw new BindingConflict();
        }
        // One owner-qualified upsert acquires the identity parent lock. An
        // INSERT DO NOTHING followed by SELECT has a release/delete gap that
        // can reject a valid concurrent claim after cleanup removes the row.
        // Existing ownership is NEVER changed; another owner's row returns none.
        const [owner] = await tx
          .insert(discordUserIdentities)
          .values({
            discordUserId: evidence.discordUserId,
            userId: attempt.userId,
          })
          .onConflictDoUpdate({
            target: discordUserIdentities.discordUserId,
            set: { userId: attempt.userId },
            setWhere: eq(discordUserIdentities.userId, attempt.userId),
          })
          .returning({ userId: discordUserIdentities.userId });
        signal.throwIfAborted();
        if (owner?.userId !== attempt.userId) {
          throw new BindingConflict();
        }
        const [inserted] = await tx
          .insert(discordOrgConnections)
          .values({
            guildId: evidence.guildId,
            userId: attempt.userId,
            discordUserId: evidence.discordUserId,
            createdAt: nowDate(),
          })
          .onConflictDoNothing()
          .returning({ id: discordOrgConnections.id });
        signal.throwIfAborted();
        const [connection] = await tx
          .select({ id: discordOrgConnections.id })
          .from(discordOrgConnections)
          .where(
            and(
              eq(discordOrgConnections.guildId, evidence.guildId),
              eq(discordOrgConnections.userId, attempt.userId),
              eq(discordOrgConnections.discordUserId, evidence.discordUserId),
            ),
          );
        signal.throwIfAborted();
        if (!connection) {
          throw new BindingConflict();
        }
        const recipients = await discordOrgChangedUserIds(tx, attempt.orgId, [
          attempt.userId,
        ]);
        signal.throwIfAborted();
        return {
          connectionId: connection.id,
          inserted: inserted?.id === connection.id,
          recipients,
        };
      }),
      signal,
    );
    if (!result.ok) {
      if (result.error instanceof InvalidAttempt) {
        return "invalid";
      }
      if (!(result.error instanceof BindingConflict)) {
        throw result.error;
      }
      await consumeConflictedAttempt(db, attempt, signal);
      return "conflict";
    }
    await publishDiscordChanged(result.value.recipients);
    signal.throwIfAborted();
    if (result.value.inserted) {
      await set(
        notifyDiscordConnection$,
        {
          connectionId: result.value.connectionId,
          orgId: attempt.orgId,
          userId: attempt.userId,
        },
        signal,
      );
    }
    return "saved";
  },
);
