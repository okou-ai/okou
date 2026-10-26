import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

const DROPBOX_AUTHORIZATION_URL = "https://www.dropbox.com/oauth2/authorize";

const DROPBOX_CURRENT_ACCOUNT_URL =
  "https://api.dropboxapi.com/2/users/get_current_account";

interface DropboxUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DropboxTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DropboxUserInfo;
}

interface DropboxRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Dropbox OAuth authorization URL.
 * Requests offline access to obtain a refresh token.
 */
export function buildDropboxAuthorizationUrl(
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
    token_access_type: "offline",
    force_reapprove: "true",
  });

  return `${DROPBOX_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 */
export async function exchangeDropboxCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DropboxTokenResult> {
  const response = await fetch(DROPBOX_TOKEN_URL, {
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
    await throwOAuthError("Dropbox", "exchange", response);
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
    throw new Error("No access token in Dropbox response");
  }

  const userInfo = await fetchDropboxUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Dropbox access token using the refresh token.
 * Returns new access token (Dropbox does not rotate refresh tokens).
 * Access token expires_in: 14400s (4 hours). Ref: https://developers.dropbox.com/oauth-guide
 */
export async function refreshDropboxToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<DropboxRefreshResult> {
  const response = await fetch(DROPBOX_TOKEN_URL, {
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
    await throwOAuthError("Dropbox", "refresh", response);
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
    throw new Error("No access token in Dropbox refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Dropbox user info using the get_current_account endpoint.
 */
async function fetchDropboxUserInfo(
  accessToken: string,
): Promise<DropboxUserInfo> {
  const response = await fetch(DROPBOX_CURRENT_ACCOUNT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Dropbox user info fetch failed: ${response.status}`);
  }

  const data = object({
    account_id: string().optional(),
    name: object({ display_name: string().nullable().optional() })
      .nullable()
      .optional(),
    email: string().nullable().optional(),
  }).parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.account_id, "Dropbox"),
    username: data.name?.display_name ?? null,
    email: data.email ?? null,
  };
}
