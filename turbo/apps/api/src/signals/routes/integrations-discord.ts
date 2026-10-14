import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  discordOrgStatus,
  createDiscordUserBinding,
  selectDiscordDmBinding$,
  discordMemberRole,
  disconnectDiscordBinding$,
} from "../services/discord-data.service";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";

function unavailable() {
  return {
    status: 404 as const,
    body: {
      error: { code: "NOT_FOUND", message: "Discord binding not found" },
    },
  };
}

const discordStatus$ = discordOrgStatus(organizationAuthContext$);

const getDiscordStatus$ = computed(async (get) => {
  return {
    status: 200 as const,
    body: await get(discordStatus$),
  };
});

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
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message:
              "Manage the bot in Discord. To unlink your account, use Disconnect Discord.",
          },
        },
      };
    }
    const [connection] = await db
      .select({
        id: discordOrgConnections.id,
        discordUserId: discordOrgConnections.discordUserId,
      })
      .from(discordOrgConnections)
      .innerJoin(
        discordOauthStates,
        eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
      )
      .where(
        and(
          eq(discordOrgConnections.userId, auth.userId),
          eq(discordOauthStates.orgId, auth.orgId),
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

const dmSelectionIdentity$ = computed((get) => {
  return Promise.resolve(get(organizationAuthContext$));
});
const dmSelectionBinding$ = createDiscordUserBinding(dmSelectionIdentity$);

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
  const binding = await get(dmSelectionBinding$);
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
