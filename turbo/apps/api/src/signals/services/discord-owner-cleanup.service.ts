import { command } from "ccstate";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { and, count, eq, gte } from "drizzle-orm";
import { writeDb$ } from "../external/db";

/** Personal grants revoke children by FK; shared installation consent survives. */
export const deleteDiscordOrgMemberData$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(writeDb$)
      .delete(discordOauthStates)
      .where(
        and(
          eq(discordOauthStates.userId, args.userId),
          eq(discordOauthStates.orgId, args.orgId),
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
    await db
      .with(revoked)
      .delete(discordOrgGrants)
      .where(
        and(
          eq(discordOrgGrants.orgId, orgId),
          gte(db.select({ count: count() }).from(revoked), 0),
        ),
      );
    signal.throwIfAborted();
  },
);
