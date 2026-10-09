import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { z } from "zod";

import { throwOAuthError } from "./error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "./scope";

const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const MICROSOFT_AUTHORIZATION_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

const MICROSOFT_USERINFO_URL = "https://graph.microsoft.com/v1.0/me";

type MicrosoftOAuthConnectorSlug =
  "microsoft-365" | "outlook-calendar" | "outlook-mail";

interface MicrosoftUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface MicrosoftTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MicrosoftUserInfo;
}

interface MicrosoftRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Microsoft OAuth authorization URL for any Microsoft connector.
 * Requests offline access to obtain a refresh token.
 */
export function buildMicrosoftAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  connectorSlug: MicrosoftOAuthConnectorSlug,
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
    prompt: "consent",
  });

  return `${MICROSOFT_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info via Microsoft OAuth.
 * Uses the Microsoft Graph /me endpoint to identify the user.
 */
export async function exchangeMicrosoftOAuthCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  connectorSlug: MicrosoftOAuthConnectorSlug,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MicrosoftTokenResult> {
  const response = await fetch(MICROSOFT_TOKEN_URL, {
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

  const userInfo = await fetchMicrosoftUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Microsoft access token using the refresh token.
 * Works for any Microsoft connector (Outlook Calendar, etc.).
 * Microsoft rotates refresh tokens on each refresh.
 * Access token expires_in: 3600-5400s (~75 min). Ref: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export async function refreshMicrosoftToken(
  connectorSlug: MicrosoftOAuthConnectorSlug,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<MicrosoftRefreshResult> {
  const response = await fetch(MICROSOFT_TOKEN_URL, {
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

/**
 * Fetch user info from Microsoft Graph /me endpoint.
 * Works with any Microsoft connector that includes the User.Read scope.
 */
async function fetchMicrosoftUserInfo(
  accessToken: string,
): Promise<MicrosoftUserInfo> {
  const response = await fetch(MICROSOFT_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Microsoft user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      mail: z.string().nullable().optional(),
      userPrincipalName: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    email: data.mail ?? data.userPrincipalName ?? null,
    name: data.displayName ?? null,
  };
}
