import { array, number, object, string, union } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const DEEL_TOKEN_URL = "https://app.deel.com/oauth2/tokens";

const DEEL_AUTHORIZATION_URL = "https://app.deel.com/oauth2/authorize";

const DEEL_PEOPLE_ME_URL = "https://api.letsdeel.com/rest/people/me";

interface DeelUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DeelTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DeelUserInfo;
}

interface DeelRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

const deelPersonSchema = object({
  id: union([string(), number()]).optional(),
  full_name: string().nullable().optional(),
  first_name: string().nullable().optional(),
  last_name: string().nullable().optional(),
  email: string().nullable().optional(),
  emails: array(
    object({
      type: string().optional(),
      value: string().nullable().optional(),
    }),
  ).optional(),
}).passthrough();

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":deel-pkce-verifier");
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
 * Build Deel OAuth authorization URL with PKCE code_challenge.
 */
export async function buildDeelAuthorizationUrl(
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

  return `${DEEL_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Refresh a Deel access token using the refresh token.
 * Deel uses Basic Auth for token requests. PKCE is not required for refresh.
 * Returns new access token and new refresh token (both must be stored).
 * Access token expires_in: 2592000s (30 days). Ref: https://developer.deel.com/docs/oauth2
 */
export async function refreshDeelToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<DeelRefreshResult> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(DEEL_TOKEN_URL, {
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
    await throwOAuthError("Deel", "refresh", response);
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
    throw new Error("No access token in Deel refresh response");
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
export async function exchangeDeelCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<DeelTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(DEEL_TOKEN_URL, {
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
    await throwOAuthError("Deel", "exchange", response);
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
    throw new Error("No access token in Deel response");
  }

  const userInfo = await fetchDeelUserInfo(clientId, data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Fetch the current Deel user's personal profile via /rest/people/me.
 * Requires the people:read scope.
 */
async function fetchDeelUserInfo(
  clientId: string,
  accessToken: string,
): Promise<DeelUserInfo> {
  const response = await fetch(DEEL_PEOPLE_ME_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-client-id": clientId,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Deel user info fetch failed: ${response.status}`);
  }

  const data = deelPersonSchema
    .extend({ data: deelPersonSchema.optional() })
    .parse(await response.json());

  // Deel documents a root profile object; tolerate the `data` wrapper observed on the earlier v2 profile response so endpoint migration does not break existing tenant variants. Ref: https://developer.deel.com/api/reference/endpoints/people/get-my-current-personal-profile-v-2026-01-01
  const person = data.data ?? data;
  const name =
    person.full_name ??
    [person.first_name, person.last_name].filter(Boolean).join(" ");
  const email = person.email ?? person.emails?.[0]?.value ?? null;

  return {
    id: requireConnectorGrantUserId(person.id?.toString(), "Deel"),
    username: name || null,
    email,
  };
}
