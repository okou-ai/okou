import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

const ZOOM_AUTHORIZATION_URL = "https://zoom.us/oauth/authorize";

const ZOOM_ME_URL = "https://api.zoom.us/v2/users/me";

interface ZoomUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface ZoomTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: ZoomUserInfo;
}

interface ZoomRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Zoom OAuth authorization URL.
 */
export function buildZoomAuthorizationUrl(
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

  return `${ZOOM_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Zoom requires Basic auth header (base64 of clientId:clientSecret) and
 * sends client credentials only in the header — not the form body.
 * Ref: https://developers.zoom.us/docs/integrations/oauth/
 */
export async function exchangeZoomCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<ZoomTokenResult> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(ZOOM_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Zoom", "exchange", response);
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
    throw new Error("No access token in Zoom response");
  }

  const userInfo = await fetchZoomUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Zoom access token using the refresh token.
 * Access token expires_in: 3600s (1 hour); refresh token TTL: 90 days.
 * Ref: https://developers.zoom.us/docs/integrations/oauth/
 */
export async function refreshZoomToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<ZoomRefreshResult> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(ZOOM_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Zoom", "refresh", response);
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
    throw new Error("No access token in Zoom refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Zoom user profile info.
 */
async function fetchZoomUserInfo(accessToken: string): Promise<ZoomUserInfo> {
  const response = await fetch(ZOOM_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Zoom user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string().optional(),
      email: z.string().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
      display_name: z.string().nullable().optional(),
    })
    .parse(await response.json());

  if (!data.id) {
    throw new Error("No user id in Zoom user info response");
  }

  const username =
    data.display_name ??
    [data.first_name, data.last_name].filter(Boolean).join(" ").trim();

  return {
    id: data.id,
    username: username || null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Zoom connector (the access token).
 */
export function getZoomSecretName(): string {
  return "ZOOM_ACCESS_TOKEN";
}
