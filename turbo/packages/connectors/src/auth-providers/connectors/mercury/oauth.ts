import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const MERCURY_ENDPOINTS = {
  production: {
    oauthBaseUrl: "https://oauth2.mercury.com",
    apiBaseUrl: "https://api.mercury.com",
  },
  sandbox: {
    oauthBaseUrl: "https://oauth2-sandbox.mercury.com",
    apiBaseUrl: "https://api-sandbox.mercury.com",
  },
} as const;

/**
 * Mercury expects the granted scope on every refresh request as well as on
 * the authorization request; a refresh without it fails once the first access
 * token expires. Refresh calls carry no grant config, so the scope is pinned
 * here and must stay equal to the Mercury connector catalog grant scopes.
 * Mercury grants read-only access, so there is no write scope.
 */
const MERCURY_OAUTH_SCOPES = ["read", "offline_access"] as const;

interface MercuryEndpoints {
  oauthBaseUrl: string;
  apiBaseUrl: string;
}

/**
 * Mercury runs production and sandbox as separate OAuth2 servers, and a client
 * only exists on the one it was registered with. Set
 * MERCURY_OAUTH_ENVIRONMENT=sandbox wherever the sandbox client credentials are
 * configured, otherwise the authorization request fails with invalid_client.
 * An unset or empty value selects production; any other value is a deployment
 * misconfiguration and fails instead of silently using production.
 * Ref: https://docs.mercury.com/docs/using-mercury-sandbox
 */
function mercuryEndpoints(): MercuryEndpoints {
  const environment = process.env.MERCURY_OAUTH_ENVIRONMENT;
  if (environment === undefined || environment === "") {
    return MERCURY_ENDPOINTS.production;
  }
  if (environment === "production") {
    return MERCURY_ENDPOINTS.production;
  }
  if (environment === "sandbox") {
    return MERCURY_ENDPOINTS.sandbox;
  }
  throw new Error(
    'MERCURY_OAUTH_ENVIRONMENT must be "sandbox" or "production"',
  );
}

/**
 * Mercury registers OAuth clients with token_endpoint_auth_method
 * client_secret_basic, so credentials go in the Authorization header rather
 * than the request body.
 */
function mercuryClientAuthHeader(
  clientId: string,
  clientSecret: string,
): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Derive a PKCE code_verifier deterministically from the OAuth state so the
 * callback can replay it without storing the verifier.
 */
async function deriveCodeVerifier(state: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(state + ":mercury-pkce-verifier");
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

interface MercuryUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface MercuryTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MercuryUserInfo;
}

interface MercuryRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Mercury OAuth authorization URL with a PKCE code_challenge.
 * Requests every scope the connector catalog declares for the client: read
 * for accounts and transactions, and offline_access for a refresh token.
 * Mercury supports the authorization code grant with PKCE.
 * Ref: https://docs.mercury.com/docs/integrations-with-oauth2
 */
export async function buildMercuryAuthorizationUrl(
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

  return `${mercuryEndpoints().oauthBaseUrl}/oauth2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Replays the PKCE code_verifier derived from the same OAuth state.
 */
export async function exchangeMercuryCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<MercuryTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);
  const response = await fetch(
    `${mercuryEndpoints().oauthBaseUrl}/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: mercuryClientAuthHeader(clientId, clientSecret),
      },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    },
  );

  if (!response.ok) {
    await throwOAuthError("Mercury", "exchange", response);
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
    throw new Error("No access token in Mercury response");
  }

  const userInfo = await fetchMercuryUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Mercury access token using the refresh token.
 * Returns new access token and new refresh token (both must be stored).
 * Mercury requires the granted scope on the refresh request.
 * Access token expires_in: 3600s (1 hour). Ref: https://docs.mercury.com/reference/obtain-the-tokens
 */
export async function refreshMercuryToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<MercuryRefreshResult> {
  const response = await fetch(
    `${mercuryEndpoints().oauthBaseUrl}/oauth2/token`,
    {
      signal,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: mercuryClientAuthHeader(clientId, clientSecret),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: MERCURY_OAUTH_SCOPES.join(" "),
      }),
    },
  );

  if (!response.ok) {
    await throwOAuthError("Mercury", "refresh", response);
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
    throw new Error("No access token in Mercury refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch the Mercury organization represented by the OAuth grant.
 */
async function fetchMercuryUserInfo(
  accessToken: string,
): Promise<MercuryUserInfo> {
  const response = await fetch(
    `${mercuryEndpoints().apiBaseUrl}/api/v1/organization`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Mercury organization fetch failed: ${response.status}`);
  }

  const data = object({
    organization: object({
      id: string(),
      legalBusinessName: string().nullable().optional(),
    }),
  }).parse(await response.json());

  // Mercury OAuth grants organization resources, so use the documented organization ID instead of a pagination-dependent first account. Ref: https://docs.mercury.com/reference/getorganization
  return {
    id: requireConnectorGrantUserId(data.organization.id, "Mercury"),
    username: data.organization.legalBusinessName ?? null,
    email: null,
  };
}
