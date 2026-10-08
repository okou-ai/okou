import { and, eq, inArray, notExists } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { discordUserIdentities } from "@okouai/db/schema/discord-user-identity";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";

/** Pure predicates: the owning transaction acquires and releases identity locks. */
export function discordIdentityOwnersWhere(discordUserIds: readonly string[]) {
  return inArray(discordUserIdentities.discordUserId, [
    ...new Set(discordUserIds),
  ]);
}

/** Execute this predicate in a FRESH statement after parent-lock acquisition. */
export function unusedDiscordIdentityOwnersWhere(
  identities: readonly { readonly discordUserId: string }[],
) {
  return and(
    discordIdentityOwnersWhere(
      identities.map((identity) => {
        return identity.discordUserId;
      }),
    ),
    notExists(
      new QueryBuilder()
        .select({ id: discordOrgConnections.id })
        .from(discordOrgConnections)
        .where(
          eq(
            discordOrgConnections.discordUserId,
            discordUserIdentities.discordUserId,
          ),
        ),
    ),
  );
}
