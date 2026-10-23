import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";

const XERO_AUTHORIZATION_URL =
  "https://login.xero.com/identity/connect/authorize";

const XERO_USERINFO_URL = "https://identity.xero.com/connect/userinfo";

interface XeroUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface XeroTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: XeroUserInfo;
}

interface XeroRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Xero OAuth authorization URL.
 */
export function buildXeroAuthorizationUrl(
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

  return `${XERO_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Xero uses form-encoded body with client_id and client_secret.
 */
export async function exchangeXeroCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<XeroTokenResult> {
  const response = await fetch(XERO_TOKEN_URL, {
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
    await throwOAuthError("Xero", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Xero response");
  }

  const userInfo = await fetchXeroUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Xero access token using the refresh token.
 * Xero rotates both access and refresh tokens on each refresh.
 * Access token expires_in: 1800s (30 min). Ref: https://developer.xero.com/documentation/guides/oauth2/auth-flow/
 */
export async function refreshXeroToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<XeroRefreshResult> {
  const response = await fetch(XERO_TOKEN_URL, {
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
    await throwOAuthError("Xero", "refresh", response);
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
    throw new Error("No access token in Xero refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Xero user info using the OpenID Connect userinfo endpoint.
 */
async function fetchXeroUserInfo(accessToken: string): Promise<XeroUserInfo> {
  const response = await fetch(XERO_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Xero user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      sub: z.string().optional(),
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.sub, "Xero"),
    username: data.name ?? null,
    email: data.email ?? null,
  };
}
