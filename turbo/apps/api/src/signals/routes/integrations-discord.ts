import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  discordOrgStatus,
  discordUserBinding,
  selectDiscordDmBinding$,
  discordMemberRole,
  disconnectDiscordBinding$,
  setDiscordAgentPreference$,
} from "../services/discord-data.service";
import {
  discordOrgChangedUserIds,
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

async function uninstallDiscordOrganization(
  db: Db,
  auth: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<boolean> {
  const recipients = await db.transaction(async (tx) => {
    const [installation] = await tx
      .select({ guildId: discordOrgInstallations.guildId })
      .from(discordOrgInstallations)
      .where(eq(discordOrgInstallations.orgId, auth.orgId))
      .for("update");
    signal.throwIfAborted();
    if (!installation) {
      return null;
    }
    const connections = await tx
      .select({ userId: discordOrgConnections.userId })
      .from(discordOrgConnections)
      .where(eq(discordOrgConnections.guildId, installation.guildId));
    signal.throwIfAborted();
    const userIds = await discordOrgChangedUserIds(tx, auth.orgId, [
      auth.userId,
      ...connections.map((connection) => {
        return connection.userId;
      }),
    ]);
    signal.throwIfAborted();
    await tx
      .delete(discordOrgInstallations)
      .where(eq(discordOrgInstallations.guildId, installation.guildId));
    signal.throwIfAborted();
    return userIds;
  });
  if (!recipients) {
    signal.throwIfAborted();
    return false;
  }
  await publishDiscordChanged(recipients);
  signal.throwIfAborted();
  return true;
}

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
      const removed = await uninstallDiscordOrganization(db, auth, signal);
      return removed
        ? { status: 200 as const, body: { ok: true as const } }
        : unavailable();
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

const setAgentPreference$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(
      bodyResultOf(integrationsDiscordContract.setAgentPreference),
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
      setDiscordAgentPreference$,
      {
        connectionId: binding.connectionId,
        discordUserId: binding.discordUserId,
        agentId: body.agentId,
      },
      signal,
    );
    return selected
      ? { status: 200 as const, body: { ok: true as const } }
      : unavailable();
  },
);

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
  {
    route: integrationsDiscordContract.setAgentPreference,
    handler: authRoute(
      { ...discordAuth, accept: ["session", "pat", "oauth"] },
      setAgentPreference$,
    ),
  },
];
