import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { discordClient } from "../external/discord-client";
import { getDiscordAppConfig } from "../services/discord-config";
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

function inviteCode(invite: string): string | null {
  const url = new URL(invite);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  const path =
    url.hostname === "discord.gg"
      ? /^\/([A-Za-z0-9_-]{1,100})\/?$/u
      : [
            "discord.com",
            "www.discord.com",
            "discordapp.com",
            "www.discordapp.com",
          ].includes(url.hostname)
        ? /^\/invite\/([A-Za-z0-9_-]{1,100})\/?$/u
        : null;
  return path?.exec(url.pathname)?.[1] ?? null;
}

const createDiscordInstallLink$ = command(
  async ({ get }, signal: AbortSignal) => {
    const body = await get(
      bodyResultOf(integrationsDiscordContract.installLink),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (!getDiscordAppConfig() || !env("DISCORD_OAUTH_CLIENT_SECRET")) {
      return createErrorResponse(
        "PROVIDER_UNAVAILABLE",
        "Discord installation is not configured.",
      );
    }
    const code = inviteCode(body.data.invite);
    if (!code) {
      return createErrorResponse(
        "BAD_REQUEST",
        "Use an HTTPS discord.gg or discord.com/invite server invitation link.",
      );
    }
    const result = await discordClient.fetchDiscordInvite(code, signal);
    signal.throwIfAborted();
    if (result.kind === "unavailable") {
      return createErrorResponse(
        "NOT_FOUND",
        "The Discord invitation is invalid, expired, or unavailable. Ask for a new server invite.",
      );
    }
    if (result.kind === "discord-error") {
      if (result.status === 429) {
        return createErrorResponse(
          "TOO_MANY_REQUESTS",
          "Discord is rate limiting invitation lookups. Try again later.",
        );
      }
      return {
        status: 502 as const,
        body: {
          error: {
            code: "DISCORD_UNAVAILABLE",
            message:
              "Discord could not verify this invitation. Try again later.",
          },
        },
      };
    }
    const { guild, type, expires_at: expiresAt } = result.data;
    if (!guild || (type !== undefined && type !== 0)) {
      return createErrorResponse(
        "BAD_REQUEST",
        "This invitation is not for a Discord server.",
      );
    }
    if (expiresAt && Date.parse(expiresAt) <= now()) {
      return createErrorResponse(
        "NOT_FOUND",
        "The Discord invitation has expired. Ask for a new server invite.",
      );
    }
    // Only public server context travels in this stable link. The recipient
    // chooses their workspace and starts browser-owned OAuth after opening it.
    // A distinct route also prevents an older App from mistaking installation
    // intent for an already-completed account connection.
    const url = new URL(
      `${INTEGRATION_SETTINGS_PATHS.discord}/install`,
      env("APP_URL"),
    );
    url.searchParams.set("guild_id", guild.id);
    return {
      status: 200 as const,
      body: { url: url.toString(), guildId: guild.id, guildName: guild.name },
    };
  },
);

const getDiscordStatus$ = computed(async (get) => {
  return {
    status: 200 as const,
    body: await get(discordStatus$),
  };
});

const deleteDiscordIntegration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const role = await get(discordMemberRole(auth));
    signal.throwIfAborted();
    if (!role) {
      return unavailable();
    }
    const db = set(writeDb$);
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
    route: integrationsDiscordContract.installLink,
    handler: authRoute(
      { ...discordAuth, requiredCapability: "discord:read" },
      createDiscordInstallLink$,
    ),
  },
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
