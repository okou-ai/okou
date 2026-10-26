import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { reportedOAuthScopes } from "../../oauth/scope";

const GARMIN_CONNECT_TOKEN_URL =
  "https://diauth.garmin.com/di-oauth2-service/oauth/token";

const GARMIN_CONNECT_AUTHORIZATION_URL =
  "https://connect.garmin.com/oauth2Confirm";

const GARMIN_USER_ID_URL = "https://apis.garmin.com/wellness-api/rest/user/id";

interface GarminConnectUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface GarminConnectTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GarminConnectUserInfo;
}

interface GarminConnectRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 * Uses the state as seed material for a reproducible verifier.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":garmin-pkce-verifier");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Compute the PKCE code_challenge from a code_verifier using S256.
 */
async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64url encode a byte array (RFC 7636).
 */
function base64UrlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => {
    return String.fromCharCode(b);
  }).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build Garmin Connect OAuth2 PKCE authorization URL.
 * Generates a code_challenge derived from the state parameter.
 */
export async function buildGarminConnectAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<string> {
  const codeVerifier = await deriveCodeVerifier(state);
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${GARMIN_CONNECT_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token with PKCE code_verifier.
 */
export async function exchangeGarminConnectCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  state: string,
): Promise<GarminConnectTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);

  const response = await fetch(GARMIN_CONNECT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      state,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Garmin Connect", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Garmin Connect response");
  }

  const userInfo = await fetchGarminConnectUserId(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: [],
    userInfo,
  };
}

/**
 * Refresh a Garmin Connect access token using the refresh token.
 * PKCE is not required for refresh — only client credentials and refresh token.
 * Garmin rotates refresh tokens — both must be stored.
 * Access token expires_in: 86400s (1 day). Ref: https://developerportal.garmin.com
 */
export async function refreshGarminConnectToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<GarminConnectRefreshResult> {
  const response = await fetch(GARMIN_CONNECT_TOKEN_URL, {
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
    await throwOAuthError("Garmin Connect", "refresh", response);
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
    throw new Error("No access token in Garmin Connect refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Garmin Connect user ID from the wellness API.
 */
async function fetchGarminConnectUserId(
  accessToken: string,
): Promise<GarminConnectUserInfo> {
  const response = await fetch(GARMIN_USER_ID_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Garmin Connect user info fetch failed: ${response.status}`,
    );
  }

  const data = object({
    userId: string().optional(),
    displayName: string().nullable().optional(),
  }).parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.userId, "Garmin Connect"),
    username: data.displayName ?? null,
    email: null,
  };
}
