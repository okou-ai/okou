import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

const X_AUTHORIZATION_URL = "https://x.com/i/oauth2/authorize";

const X_USERS_ME_URL =
  "https://api.x.com/2/users/me?user.fields=id,username,name";

interface XUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface XTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: XUserInfo;
}

interface XRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":x-pkce-verifier");
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
 * Build X OAuth2 PKCE authorization URL.
 */
export async function buildXAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
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
    scope: authCodeGrant.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${X_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Refresh an X access token using the refresh token.
 * PKCE is not required for refresh — only client credentials and refresh token.
 * Access token expires_in: 7200s (2 hours). Ref: https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code
 */
export async function refreshXToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<XRefreshResult> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(X_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("X", "refresh", response);
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
    throw new Error("No access token in X refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Exchange authorization code for access token and user info with PKCE code_verifier.
 */
export async function exchangeXCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<XTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(X_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("X", "exchange", response);
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
    throw new Error("No access token in X response");
  }

  const userInfo = await fetchXUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Fetch the authenticated X user's profile via /2/users/me.
 */
async function fetchXUserInfo(accessToken: string): Promise<XUserInfo> {
  const response = await fetch(X_USERS_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`X user info fetch failed: ${response.status}`);
  }

  const data = object({
    data: object({
      id: string(),
      username: string().nullable().optional(),
      name: string().nullable().optional(),
    }).passthrough(),
  }).parse(await response.json());

  return {
    id: data.data.id,
    username: data.data.username ?? null,
    email: null, // X API v2 does not expose email via /2/users/me
  };
}
