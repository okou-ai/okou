import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "./error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "./scope";

type GoogleOAuthConnectorSlug =
  | "gmail"
  | "google-ads"
  | "google-analytics"
  | "google-calendar"
  | "google-cloud"
  | "google-contacts"
  | "google-docs"
  | "google-drive"
  | "google-forms"
  | "google-maps"
  | "google-meet"
  | "google-search-console"
  | "google-sheets"
  | "youtube";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const GOOGLE_OAUTH_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface GoogleUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface GoogleTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GoogleUserInfo;
}

interface GoogleRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Google OAuth authorization URL for any Google connector.
 * Requests offline access to obtain a refresh token.
 */
export function buildGoogleAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  connectorSlug: GoogleOAuthConnectorSlug,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${GOOGLE_OAUTH_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info via Google OAuth.
 * Uses the Google userinfo endpoint to identify the user.
 */
export async function exchangeGoogleOAuthCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  connectorSlug: GoogleOAuthConnectorSlug,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResult> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError(connectorSlug, "exchange", response);
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
    throw new Error(`No access token in ${connectorSlug} response`);
  }

  const userInfo = await fetchGoogleUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Google access token using the refresh token.
 * Works for any Google connector (Gmail, Sheets, Docs, Drive).
 * Returns new access token (Google does not rotate refresh tokens).
 * Access token expires_in: 3600s (1 hour). Ref: https://developers.google.com/identity/protocols/oauth2/web-server
 */
export async function refreshGoogleToken(
  connectorSlug: GoogleOAuthConnectorSlug,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<GoogleRefreshResult> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError(connectorSlug, "refresh", response);
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
    throw new Error(`No access token in ${connectorSlug} refresh response`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

export async function revokeGoogleToken(
  connectorSlug: GoogleOAuthConnectorSlug,
  token: string,
): Promise<void> {
  const response = await fetch(GOOGLE_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token,
    }),
  });

  if (!response.ok) {
    await throwOAuthError(connectorSlug, "revoke", response);
  }
}

/**
 * Fetch user info from Google OAuth2 userinfo endpoint.
 * Works with any Google connector that includes the userinfo.email scope.
 */
async function fetchGoogleUserInfo(
  accessToken: string,
): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      email: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    email: data.email ?? null,
    name: data.name ?? null,
  };
}
