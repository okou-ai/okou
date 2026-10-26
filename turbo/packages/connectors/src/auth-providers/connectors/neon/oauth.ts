import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const NEON_TOKEN_URL = "https://oauth2.neon.tech/oauth2/token";

const NEON_AUTHORIZATION_URL = "https://oauth2.neon.tech/oauth2/auth";

const NEON_USER_INFO_URL = "https://console.neon.tech/api/v2/users/me";

interface NeonUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface NeonTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: NeonUserInfo;
}

interface NeonRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Neon OAuth authorization URL.
 * Requests offline_access to obtain a refresh token.
 */
export function buildNeonAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    state,
    redirect_uri: redirectUri,
    scope: authCodeGrant.scopes.join(" "),
  });

  return `${NEON_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Uses client_secret_post (form body) for token exchange.
 */
export async function exchangeNeonCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<NeonTokenResult> {
  const response = await fetch(NEON_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Neon", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    scope: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Neon response");
  }

  const userInfo = await fetchNeonUserInfo(data.access_token);
  const scopes = effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " ");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes,
    userInfo,
  };
}

/**
 * Refresh an expired Neon access token using the refresh token.
 * Access token expires_in: expected (OIDC-compliant) but not explicitly documented. Ref: https://neon.com/docs/guides/oauth-integration
 */
export async function refreshNeonToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<NeonRefreshResult> {
  const response = await fetch(NEON_TOKEN_URL, {
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
    await throwOAuthError("Neon", "refresh", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    scope: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Neon refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Neon user info from /api/v2/users/me.
 */
async function fetchNeonUserInfo(accessToken: string): Promise<NeonUserInfo> {
  const response = await fetch(NEON_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Neon user info fetch failed: ${response.status}`);
  }

  const data = object({
    id: string(),
    name: string().nullable().optional(),
    email: string().nullable().optional(),
  }).parse(await response.json());

  return {
    id: data.id,
    username: data.name ?? null,
    email: data.email ?? null,
  };
}
