import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const SUPABASE_TOKEN_URL = "https://api.supabase.com/v1/oauth/token";

const SUPABASE_AUTHORIZATION_URL =
  "https://api.supabase.com/v1/oauth/authorize";

const SUPABASE_PROFILE_URL = "https://api.supabase.com/v1/profile";

interface SupabaseUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface SupabaseTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: SupabaseUserInfo;
}

interface SupabaseRefreshResult {
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
  const data = encoder.encode(state + ":supabase-pkce-verifier");
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
 * Build Supabase OAuth authorization URL with PKCE code_challenge.
 */
export async function buildSupabaseAuthorizationUrl(
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

  return `${SUPABASE_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Refresh a Supabase access token using the refresh token.
 * Supabase uses Basic Auth for token requests. PKCE is not required for refresh.
 * Access token expires_in: 3600s (1 hour, configurable). Ref: https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
 */
export async function refreshSupabaseToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<SupabaseRefreshResult> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(SUPABASE_TOKEN_URL, {
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
    await throwOAuthError("Supabase", "refresh", response);
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
    throw new Error("No access token in Supabase refresh response");
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
 * Supabase uses Basic Auth (Base64 of clientId:clientSecret) for token exchange.
 */
export async function exchangeSupabaseCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<SupabaseTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(SUPABASE_TOKEN_URL, {
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
    await throwOAuthError("Supabase", "exchange", response);
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
    throw new Error("No access token in Supabase response");
  }

  const userInfo = await fetchSupabaseUserInfo(data.access_token);
  const scopes = effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " ");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes,
    userInfo,
  };
}

/**
 * Fetch the current Supabase user's profile.
 */
async function fetchSupabaseUserInfo(
  accessToken: string,
): Promise<SupabaseUserInfo> {
  const response = await fetch(SUPABASE_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Supabase profile fetch failed: ${response.status}`);
  }

  const data = object({
    gotrue_id: string(),
    primary_email: string().nullable().optional(),
    username: string().nullable().optional(),
  }).parse(await response.json());

  // Supabase documents `gotrue_id` on `/v1/profile` as the OAuth user's identity, avoiding unstable organization-list ordering. Ref: https://api.supabase.com/api/v1#tag/profile/GET/v1/profile
  return {
    id: requireConnectorGrantUserId(data.gotrue_id, "Supabase"),
    username: data.username ?? null,
    email: data.primary_email ?? null,
  };
}
