import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

const SPOTIFY_AUTHORIZATION_URL = "https://accounts.spotify.com/authorize";

const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";

interface SpotifyUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface SpotifyTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SpotifyUserInfo;
}

interface SpotifyRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Spotify OAuth authorization URL.
 */
export function buildSpotifyAuthorizationUrl(
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

  return `${SPOTIFY_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Spotify requires Basic auth header (base64 of clientId:clientSecret).
 */
export async function exchangeSpotifyCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SpotifyTokenResult> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(SPOTIFY_TOKEN_URL, {
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
    await throwOAuthError("Spotify", "exchange", response);
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
    throw new Error("No access token in Spotify response");
  }

  const userInfo = await fetchSpotifyUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Spotify access token using the refresh token.
 * Uses Basic auth header (base64 of clientId:clientSecret).
 */
export async function refreshSpotifyToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<SpotifyRefreshResult> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(SPOTIFY_TOKEN_URL, {
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
    await throwOAuthError("Spotify", "refresh", response);
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
    throw new Error("No access token in Spotify refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Spotify user profile info.
 */
async function fetchSpotifyUserInfo(
  accessToken: string,
): Promise<SpotifyUserInfo> {
  const response = await fetch(SPOTIFY_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      account_id: z.string().optional(),
      id: z.string().optional(),
      display_name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  // Spotify defines `account_id` as the immutable account-linking key; tolerate legacy responses that only expose `id`. Ref: https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
  const id = data.account_id ?? data.id;
  if (!id) {
    throw new Error("No user id in Spotify user info response");
  }

  return {
    id,
    username: data.display_name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Spotify connector (the access token).
 */
export function getSpotifySecretName(): string {
  return "SPOTIFY_ACCESS_TOKEN";
}
