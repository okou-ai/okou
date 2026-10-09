import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { writeDb$ } from "../external/db";

/** Personal grants revoke children by FK; shared installation consent survives. */
export const deleteDiscordOrgMemberData$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const revoked = db.$with("revoked_discord_member_grants").as(
      db
        .delete(discordOauthStates)
        .where(
          and(
            eq(discordOauthStates.userId, args.userId),
            eq(discordOauthStates.orgId, args.orgId),
          ),
        )
        .returning({ id: discordOauthStates.id }),
    );
    await db
      .with(revoked)
      .delete(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, args.userId),
          isNull(discordOrgConnections.oauthGrantId),
          inArray(
            discordOrgConnections.guildId,
            db
              .select({ guildId: discordOrgInstallations.guildId })
              .from(discordOrgInstallations)
              .where(eq(discordOrgInstallations.orgId, args.orgId)),
          ),
          gte(db.select({ count: count() }).from(revoked), 0),
        ),
      );
    signal.throwIfAborted();
  },
);

export const deleteDiscordOrgData$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const revoked = db
      .$with("revoked_discord_org_member_grants")
      .as(
        db
          .delete(discordOauthStates)
          .where(eq(discordOauthStates.orgId, orgId))
          .returning({ id: discordOauthStates.id }),
      );
    const uninstalled = db.$with("revoked_discord_org_installation_grants").as(
      db
        .delete(discordOrgGrants)
        .where(
          and(
            eq(discordOrgGrants.orgId, orgId),
            gte(db.select({ count: count() }).from(revoked), 0),
          ),
        )
        .returning({ id: discordOrgGrants.id }),
    );
    await db
      .with(revoked, uninstalled)
      .delete(discordOrgInstallations)
      .where(
        and(
          eq(discordOrgInstallations.orgId, orgId),
          isNull(discordOrgInstallations.orgGrantId),
          gte(db.select({ count: count() }).from(uninstalled), 0),
        ),
      );
    signal.throwIfAborted();
  },
);

export const deleteDiscordUserData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const revoked = db
      .$with("revoked_discord_account_grants")
      .as(
        db
          .delete(discordOauthStates)
          .where(eq(discordOauthStates.userId, userId))
          .returning({ id: discordOauthStates.id }),
      );
    const anonymized = db.$with("anonymized_discord_installation_consent").as(
      db
        .update(discordOrgGrants)
        .set({ initiatedByUserId: null })
        .where(
          and(
            eq(discordOrgGrants.initiatedByUserId, userId),
            gte(db.select({ count: count() }).from(revoked), 0),
          ),
        )
        .returning({ id: discordOrgGrants.id }),
    );
    const legacyConnections = db
      .$with("revoked_legacy_discord_account_connections")
      .as(
        db
          .delete(discordOrgConnections)
          .where(
            and(
              eq(discordOrgConnections.userId, userId),
              isNull(discordOrgConnections.oauthGrantId),
            ),
          )
          .returning({ id: discordOrgConnections.id }),
      );
    // The grant-installer FK clears even an installation committed while the
    // first DELETE waited. Only genuinely historical rows need a direct UPDATE.
    await db
      .with(revoked, anonymized, legacyConnections)
      .update(discordOrgInstallations)
      .set({ installedByUserId: null })
      .where(
        and(
          eq(discordOrgInstallations.installedByUserId, userId),
          isNull(discordOrgInstallations.orgGrantId),
          gte(db.select({ count: count() }).from(anonymized), 0),
        ),
      );
    signal.throwIfAborted();
  },
);
