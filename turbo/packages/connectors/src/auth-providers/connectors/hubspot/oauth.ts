import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { reportedOAuthScopes } from "../../oauth/scope";

const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

const HUBSPOT_AUTHORIZATION_URL = "https://app.hubspot.com/oauth/authorize";

const HUBSPOT_TOKEN_INFO_URL = "https://api.hubapi.com/oauth/v1/access-tokens";

interface HubSpotUserInfo {
  id: string;
  email: string | null;
  hubDomain: string | null;
}

interface HubSpotTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: HubSpotUserInfo;
}

interface HubSpotRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build HubSpot OAuth authorization URL.
 */
export function buildHubSpotAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: authCodeGrant.scopes.join(" "),
    state,
  });

  return `${HUBSPOT_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeHubSpotCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<HubSpotTokenResult> {
  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("HubSpot", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in HubSpot response");
  }

  const userInfo = await fetchHubSpotUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: authCodeGrant.scopes,
    userInfo,
  };
}

/**
 * Refresh a HubSpot access token using the refresh token.
 * Access token expires_in: 1800s (30 min). Ref: https://developers.hubspot.com/docs/api-reference/auth-oauth-v1/guide
 */
export async function refreshHubSpotToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<HubSpotRefreshResult> {
  const response = await fetch(HUBSPOT_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("HubSpot", "refresh", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in HubSpot refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch HubSpot user info using the access token introspection endpoint.
 */
async function fetchHubSpotUserInfo(
  accessToken: string,
): Promise<HubSpotUserInfo> {
  const response = await fetch(`${HUBSPOT_TOKEN_INFO_URL}/${accessToken}`);

  if (!response.ok) {
    throw new Error(`HubSpot user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      user_id: z.number(),
      user: z.string().optional(),
      hub_domain: z.string().optional(),
    })
    .parse(await response.json());

  return {
    id: String(data.user_id),
    email: data.user ?? null,
    hubDomain: data.hub_domain ?? null,
  };
}
