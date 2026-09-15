import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { teamsOauthContract } from "@okouai/api-contracts/contracts/teams-oauth";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  buildTeamsInstallUrl,
  connectTeamsInstallation$,
  isTeamsInstallationActive,
  prepareTeamsInstallation$,
  publishTeamsChanged$,
} from "../services/teams-connect.service";
import { safeJsonParse, tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const L = logger("TeamsOAuth");
const MICROSOFT_AUTHORIZATION_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me";
const REDIRECT_STATUS = 307;
const MAX_PROMPT_STATE_LENGTH = 500;
const MICROSOFT_TEAMS_CONNECT_SCOPES = [
  "openid",
  "profile",
  "email",
  "User.Read",
] as const;

interface OAuthState {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly prompt: string | null;
  readonly publicBrand: PublicBrand;
  readonly redirectUri: string;
}

interface MicrosoftTeamsUserInfo {
  readonly id: string;
  readonly displayName: string | null;
  readonly userPrincipalName: string | null;
  readonly mail: string | null;
}

interface MicrosoftTeamsOAuthResult {
  readonly tenantId: string;
  readonly user: MicrosoftTeamsUserInfo;
}

interface TeamsOauthAuth {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "admin" | "member";
}

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function noStoreRedirect(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url, "Cache-Control": "no-store" },
  });
}

function jsonErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appUrl(path: string): string {
  return `${env("APP_URL")}${path}`;
}

function settingsErrorRedirect(message: string): Response {
  return redirectResponse(
    appUrl(`/settings/teams?error=${encodeURIComponent(message)}`),
  );
}

function settingsSuccessRedirect(args: {
  readonly tenantName?: string | null;
  readonly teamName?: string | null;
  readonly botName?: string | null;
}): Response {
  const params = new URLSearchParams({ status: "connected" });
  if (args.tenantName) {
    params.set("tenantName", args.tenantName);
  }
  if (args.teamName) {
    params.set("teamName", args.teamName);
  }
  params.set("botName", teamsBotDisplayName(args.botName));
  return redirectResponse(appUrl(`/settings/teams?${params.toString()}`));
}

function teamsInstallRedirect(tenantId: string): Response {
  const installUrl = buildTeamsInstallUrl(tenantId);
  if (!installUrl) {
    return settingsErrorRedirect(
      "Microsoft Teams integration is not configured.",
    );
  }
  return noStoreRedirect(installUrl);
}

function truncatePrompt(prompt: string): string {
  return [...prompt].slice(0, MAX_PROMPT_STATE_LENGTH).join("");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseOAuthState(state: string | undefined): OAuthState | null {
  if (!state) {
    return null;
  }

  const parsed = safeJsonParse(state);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const publicBrand = record.publicBrand;
  const redirectUri = optionalString(record.redirectUri);
  if ((publicBrand !== "vm0" && publicBrand !== "okou") || !redirectUri) {
    return null;
  }
  return {
    orgId: optionalString(record.orgId),
    userId: optionalString(record.userId),
    prompt: optionalString(record.prompt),
    publicBrand,
    redirectUri,
  };
}

/**
 * Microsoft Teams uses its registered integration callback path. Keep it
 * separate from the built-in connector callback path used by other providers.
 */
function callbackRedirectUri(origin: string): string {
  return `${origin}/api/integrations/teams/oauth/callback`;
}

function microsoftCredentials(): {
  readonly clientId: string;
  readonly clientSecret: string;
} | null {
  const clientId = env("MICROSOFT_OAUTH_CLIENT_ID");
  const clientSecret = env("MICROSOFT_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }

  const parsed = safeJsonParse(Buffer.from(payload, "base64url").toString());
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
}

async function fetchMicrosoftMe(
  accessToken: string,
  signal: AbortSignal,
): Promise<MicrosoftTeamsUserInfo> {
  const response = await fetch(MICROSOFT_ME_URL, {
    signal,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Microsoft user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().min(1),
      displayName: z.string().nullable().optional(),
      userPrincipalName: z.string().nullable().optional(),
      mail: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    displayName: data.displayName ?? null,
    userPrincipalName: data.userPrincipalName ?? null,
    mail: data.mail ?? null,
  };
}

async function exchangeMicrosoftTeamsOAuthCode(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<MicrosoftTeamsOAuthResult> {
  const response = await fetch(MICROSOFT_TOKEN_URL, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`Microsoft OAuth exchange failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      id_token: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new Error("No access token in Microsoft OAuth response");
  }
  if (!data.id_token) {
    throw new Error("No ID token in Microsoft OAuth response");
  }

  const payload = jwtPayload(data.id_token);
  const tenantId = optionalString(payload?.tid);
  if (!tenantId) {
    throw new Error("No tenant id in Microsoft OAuth response");
  }

  return {
    tenantId,
    user: await fetchMicrosoftMe(data.access_token, signal),
  };
}

const resolveTeamsOauthStateAuth$ = command(
  async (
    { set },
    state: OAuthState,
    signal: AbortSignal,
  ): Promise<TeamsOauthAuth | null> => {
    if (!state.orgId || !state.userId) {
      return null;
    }

    const member = await set(
      getMemberRoleAndUpdateCache$,
      state.orgId,
      state.userId,
      signal,
    );
    signal.throwIfAborted();

    if (member.kind !== "member") {
      return null;
    }

    return {
      userId: state.userId,
      orgId: state.orgId,
      orgRole: member.role,
    };
  },
);

const connectOauth$ = command(({ get }) => {
  const request = get(request$).raw;
  const publicBrand = PUBLIC_BRAND;
  const origin = getOAuthApiOrigin(request);
  const credentials = microsoftCredentials();
  if (!credentials) {
    return jsonErrorResponse(
      "Microsoft Teams integration is not configured",
      503,
    );
  }

  const query = get(queryOf(teamsOauthContract.connect));
  const userId = query.userId;
  if (!query.orgId || !userId) {
    return jsonErrorResponse("Missing orgId or userId", 400);
  }

  // Record the redirect URI this authorization actually sends, so the token
  // exchange can repeat it instead of recomputing a value that may have moved.
  const redirectUri = callbackRedirectUri(origin);
  const stateObj: {
    orgId: string;
    userId: string;
    prompt?: string;
    publicBrand: PublicBrand;
    redirectUri: string;
  } = {
    orgId: query.orgId,
    userId,
    publicBrand,
    redirectUri,
  };
  if (query.prompt) {
    stateObj.prompt = truncatePrompt(query.prompt);
  }

  const authUrl = new URL(MICROSOFT_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", credentials.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", MICROSOFT_TEAMS_CONNECT_SCOPES.join(" "));
  authUrl.searchParams.set("state", JSON.stringify(stateObj));
  authUrl.searchParams.set("prompt", "select_account");

  return noStoreRedirect(authUrl.toString());
});

const callbackOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  const credentials = microsoftCredentials();
  if (!credentials) {
    return jsonErrorResponse(
      "Microsoft Teams integration is not configured",
      503,
    );
  }

  const query = get(queryOf(teamsOauthContract.callback));
  const state = parseOAuthState(query.state);
  if (query.error) {
    return settingsErrorRedirect(query.error_description ?? query.error);
  }
  if (!query.code) {
    return jsonErrorResponse("Missing authorization code", 400);
  }

  if (!state?.orgId || !state.userId) {
    return settingsErrorRedirect("Invalid connect state.");
  }

  const auth = await set(resolveTeamsOauthStateAuth$, state, signal);
  if (!auth) {
    return settingsErrorRedirect("Invalid connect state.");
  }

  const exchange = await tapError(
    exchangeMicrosoftTeamsOAuthCode(
      {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code: query.code,
        redirectUri: state.redirectUri,
      },
      signal,
    ),
    (error) => {
      L.error("Microsoft Teams OAuth exchange failed", { error });
    },
  );
  signal.throwIfAborted();

  if (!exchange) {
    return settingsErrorRedirect(
      "Failed to connect Microsoft Teams account. Please try again.",
    );
  }

  const connectArgs = {
    userId: auth.userId,
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    tenantId: exchange.tenantId,
    teamsAadObjectId: exchange.user.id,
    teamsUserDisplayName: exchange.user.displayName ?? undefined,
    teamsUserPrincipalName:
      exchange.user.userPrincipalName ?? exchange.user.mail ?? undefined,
  };

  const result = await set(connectTeamsInstallation$, connectArgs, signal);
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    const prepared = await set(prepareTeamsInstallation$, connectArgs, signal);
    signal.throwIfAborted();

    if (prepared.kind !== "ok") {
      return settingsErrorRedirect(prepared.message);
    }

    await set(
      publishTeamsChanged$,
      { orgId: auth.orgId, userIds: [auth.userId] },
      signal,
    );
    signal.throwIfAborted();

    return teamsInstallRedirect(exchange.tenantId);
  }

  if (result.kind === "forbidden") {
    return settingsErrorRedirect(result.message);
  }

  await set(
    publishTeamsChanged$,
    { orgId: auth.orgId, userIds: [auth.userId] },
    signal,
  );
  signal.throwIfAborted();

  if (!isTeamsInstallationActive(result.installation)) {
    return teamsInstallRedirect(result.installation.teamsTenantId);
  }

  return settingsSuccessRedirect({
    tenantName: result.installation.teamsTenantName,
    teamName: result.installation.teamsTeamName,
    botName: result.installation.botName,
  });
});

export const teamsOauthRoutes: readonly RouteEntry[] = [
  {
    route: teamsOauthContract.connect,
    handler: connectOauth$,
  },
  {
    route: teamsOauthContract.callback,
    handler: callbackOauth$,
  },
];
