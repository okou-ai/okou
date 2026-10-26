import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const SENTRY_TOKEN_URL = "https://sentry.io/oauth/token/";

const SENTRY_AUTHORIZATION_URL = "https://sentry.io/oauth/authorize/";

interface SentryUserInfo {
  id: string;
  name: string | null;
  email: string | null;
}

interface SentryTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SentryUserInfo;
}

interface SentryRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Sentry OAuth authorization URL.
 */
export function buildSentryAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
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
  });

  return `${SENTRY_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Sentry embeds user info directly in the token response.
 */
export async function exchangeSentryCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SentryTokenResult> {
  const response = await fetch(SENTRY_TOKEN_URL, {
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
    await throwOAuthError("Sentry", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    scope: string().optional(),
    token_type: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
    user: object({
      id: string(),
      name: string().nullable().optional(),
      email: string().nullable().optional(),
    }).optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Sentry response");
  }

  if (!data.user) {
    throw new Error("No user info in Sentry token response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo: {
      id: data.user.id,
      name: data.user.name ?? null,
      email: data.user.email ?? null,
    },
  };
}

/**
 * Refresh a Sentry access token using the refresh token.
 * Access token expires_in: ~2592000s (30 days). Ref: https://docs.sentry.io/api/auth/
 */
export async function refreshSentryToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<SentryRefreshResult> {
  const response = await fetch(SENTRY_TOKEN_URL, {
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
    await throwOAuthError("Sentry", "refresh", response);
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
    throw new Error("No access token in Sentry refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}
