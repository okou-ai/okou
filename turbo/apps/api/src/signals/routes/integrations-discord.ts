import { command, computed } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { discordOrgGrants } from "@okouai/db/schema/discord-org-grant";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import type { RouteEntry } from "../route-entry";
import {
  discordOrgStatus,
  discordUserBinding,
  selectDiscordDmBinding$,
  discordMemberRole,
  disconnectDiscordBinding$,
} from "../services/discord-data.service";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import {
  discordCleanupRecipients,
  discordRemovalProjection,
  publishDiscordChanged,
} from "../services/discord-realtime.service";

function unavailable() {
  return {
    status: 404 as const,
    body: {
      error: { code: "NOT_FOUND", message: "Discord binding not found" },
    },
  };
}

const getDiscordStatus$ = computed(async (get) => {
  return {
    status: 200 as const,
    body: await get(discordOrgStatus(get(organizationAuthContext$))),
  };
});

const commitDiscordOrganizationUninstall$ = command(
  async (
    { set },
    auth: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const revoked = db.$with("revoked_discord_workspace_personal_grants").as(
      db
        .delete(discordOauthStates)
        .where(eq(discordOauthStates.orgId, auth.orgId))
        .returning({
          userId: discordOauthStates.userId,
          completionTokenHash: discordOauthStates.completionTokenHash,
        }),
    );
    const consents = db
      .$with("revoked_discord_workspace_installation_consent")
      .as(
        db
          .delete(discordOrgGrants)
          .where(
            and(
              eq(discordOrgGrants.orgId, auth.orgId),
              gte(db.select({ count: count() }).from(revoked), 0),
            ),
          )
          .returning({
            approvedAt: discordOrgGrants.approvedAt,
            guildId: discordOrgGrants.verifiedGuildId,
          }),
      );
    const legacy = db.$with("revoked_legacy_discord_workspace").as(
      db
        .delete(discordOrgInstallations)
        .where(
          and(
            eq(discordOrgInstallations.orgId, auth.orgId),
            isNull(discordOrgInstallations.orgGrantId),
            gte(db.select({ count: count() }).from(consents), 0),
          ),
        )
        .returning({ guildId: discordOrgInstallations.guildId }),
    );
    const removed = db.$with("removed_discord_workspace_guild").as(
      db
        .select({ guildId: consents.guildId })
        .from(consents)
        .where(isNotNull(consents.approvedAt))
        .unionAll(db.select({ guildId: legacy.guildId }).from(legacy)),
    );
    const hasRemoval = exists(
      db.select({ guildId: removed.guildId }).from(removed),
    );
    const admins = db
      .select(discordRemovalProjection(sql`${orgMembersCache.userId}`, true))
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, auth.orgId),
          eq(orgMembersCache.role, "admin"),
          hasRemoval,
        ),
      );
    const connections = db
      .select(
        discordRemovalProjection(sql`${discordOrgConnections.userId}`, true),
      )
      .from(discordOrgConnections)
      .where(
        and(
          inArray(
            discordOrgConnections.guildId,
            db.select({ guildId: removed.guildId }).from(removed),
          ),
          hasRemoval,
        ),
      );
    const grantOwners = db
      .select(discordRemovalProjection(sql`${revoked.userId}`, true))
      .from(revoked)
      .where(and(isNull(revoked.completionTokenHash), hasRemoval));
    // UNION ALL is linear in returned recipients, not grants × members × admins.
    const recipients = db.$with("discord_workspace_cleanup_recipients").as(
      db
        .select(discordRemovalProjection(sql`NULL`, true))
        .from(removed)
        .unionAll(admins)
        .unionAll(connections)
        .unionAll(grantOwners),
    );
    return await db
      .with(revoked, consents, legacy, removed, recipients)
      .select({ removed: recipients.removed, userId: recipients.userId })
      .from(recipients);
  },
);

const deleteDiscordIntegration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(integrationsDiscordContract.disconnect));
    // Data removal stays available while the feature is rolled back.
    const role = await get(discordMemberRole(auth));
    signal.throwIfAborted();
    if (!role) {
      return unavailable();
    }
    const db = set(writeDb$);
    if (query.action === "uninstall") {
      if (role !== "admin") {
        return {
          status: 403 as const,
          body: {
            error: { code: "FORBIDDEN", message: "Admin access required" },
          },
        };
      }
      const rows = await set(commitDiscordOrganizationUninstall$, auth, signal);
      const recipients = discordCleanupRecipients(rows, [auth.userId]);
      if (!recipients.removed) {
        signal.throwIfAborted();
        return unavailable();
      }
      // Committed changes publish before observing a post-commit cancellation.
      await publishDiscordChanged(recipients.userIds);
      signal.throwIfAborted();
      return { status: 200 as const, body: { ok: true as const } };
    }
    const [connection] = await db
      .select({
        id: discordOrgConnections.id,
        discordUserId: discordOrgConnections.discordUserId,
      })
      .from(discordOrgConnections)
      .where(
        and(
          eq(discordOrgConnections.userId, auth.userId),
          eq(
            discordOrgConnections.guildId,
            db
              .select({ guildId: discordOrgInstallations.guildId })
              .from(discordOrgInstallations)
              .where(eq(discordOrgInstallations.orgId, auth.orgId)),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return unavailable();
    }
    const removed = await set(
      disconnectDiscordBinding$,
      {
        connectionId: connection.id,
        discordUserId: connection.discordUserId,
        orgId: auth.orgId,
      },
      signal,
    );
    return removed
      ? { status: 200 as const, body: { ok: true as const } }
      : unavailable();
  },
);

const setDmSelection$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsDiscordContract.setDmSelection),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const binding = await get(discordUserBinding(auth));
  signal.throwIfAborted();
  if (!binding) {
    return unavailable();
  }
  const selected = await set(
    selectDiscordDmBinding$,
    {
      discordUserId: binding.discordUserId,
      connectionId: body.connectionId,
      userId: auth.userId,
    },
    signal,
  );
  return selected
    ? { status: 200 as const, body: { ok: true as const } }
    : unavailable();
});

const discordAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const integrationsDiscordRoutes: readonly RouteEntry[] = [
  {
    route: integrationsDiscordContract.getStatus,
    handler: authRoute(discordAuth, getDiscordStatus$),
  },
  {
    route: integrationsDiscordContract.disconnect,
    handler: authRoute(
      { ...discordAuth, accept: ["session", "pat", "oauth"] },
      deleteDiscordIntegration$,
    ),
  },
  {
    route: integrationsDiscordContract.setDmSelection,
    handler: authRoute(
      { ...discordAuth, accept: ["session", "pat", "oauth"] },
      setDmSelection$,
    ),
  },
];
