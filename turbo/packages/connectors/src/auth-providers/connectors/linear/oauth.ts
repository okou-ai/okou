import { array, number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

const LINEAR_AUTHORIZATION_URL = "https://linear.app/oauth/authorize";

// User info URL is not part of the auth-code grant config since it uses GraphQL (POST), not a standard
// REST GET endpoint. Same pattern as GMAIL_PROFILE_URL in gmail.ts.
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

interface LinearUserInfo {
  id: string;
  name: string | null;
  email: string | null;
}

interface LinearTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: LinearUserInfo;
}

interface LinearRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Linear OAuth authorization URL.
 */
export function buildLinearAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(","),
    state,
    actor: "user",
    prompt: "consent",
  });

  return `${LINEAR_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Linear uses GraphQL API to fetch user information.
 */
export async function exchangeLinearCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<LinearTokenResult> {
  const response = await fetch(LINEAR_TOKEN_URL, {
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
    await throwOAuthError("Linear", "exchange", response);
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
    throw new Error("No access token in Linear response");
  }

  const userInfo = await fetchLinearUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, ","),
    userInfo,
  };
}

/**
 * Refresh a Linear access token using the refresh token.
 * Returns new access token and new refresh token (both must be stored).
 * Access token expires_in: 86399s (24 hours). Ref: https://developers.linear.app/docs/oauth/authentication
 */
export async function refreshLinearToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<LinearRefreshResult> {
  const response = await fetch(LINEAR_TOKEN_URL, {
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
    await throwOAuthError("Linear", "refresh", response);
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
    throw new Error("No access token in Linear refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, ","),
  };
}

/**
 * Fetch Linear user info using the GraphQL API.
 */
async function fetchLinearUserInfo(
  accessToken: string,
): Promise<LinearUserInfo> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "{ viewer { id name email } }",
    }),
  });

  if (!response.ok) {
    throw new Error(`Linear user info fetch failed: ${response.status}`);
  }

  const data = object({
    data: object({
      viewer: object({
        id: string().optional(),
        name: string().nullable().optional(),
        email: string().nullable().optional(),
      }).optional(),
    }).optional(),
    errors: array(object({ message: string() })).optional(),
  }).parse(await response.json());

  if (data.errors?.length) {
    throw new Error(data.errors[0]?.message ?? "Unknown GraphQL error");
  }

  const viewer = data.data?.viewer;
  if (!viewer?.id) {
    throw new Error("No user data in Linear response");
  }

  return {
    id: viewer.id,
    name: viewer.name ?? null,
    email: viewer.email ?? null,
  };
}

/**
 * Revoke a Linear OAuth token.
 * Uses RFC 7009 token revocation endpoint with Basic Auth.
 * Ref: https://linear.app/developers/oauth-2-0-authentication
 */
export async function revokeLinearToken(
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch("https://api.linear.app/oauth/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      token: accessToken,
      token_type_hint: "access_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Linear token revocation failed: ${response.status}`);
  }
}
