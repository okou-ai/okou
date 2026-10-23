import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";

const CANVA_AUTHORIZATION_URL = "https://www.canva.com/api/oauth/authorize";

const CANVA_ME_URL = "https://api.canva.com/rest/v1/users/me";
const CANVA_PROFILE_URL = "https://api.canva.com/rest/v1/users/me/profile";

interface CanvaUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface CanvaTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: CanvaUserInfo;
}

interface CanvaRefreshResult {
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
  const data = encoder.encode(state + ":canva-pkce-verifier");
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
 * Build Canva OAuth authorization URL with PKCE code_challenge.
 */
export async function buildCanvaAuthorizationUrl(
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

  return `${CANVA_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Refresh a Canva access token using the refresh token.
 * Canva uses Basic Auth for token requests. PKCE is not required for refresh.
 * Access token expires_in: 14400s (4 hours). Ref: https://www.canva.dev/docs/connect/authentication/
 */
export async function refreshCanvaToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<CanvaRefreshResult> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(CANVA_TOKEN_URL, {
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
    await throwOAuthError("Canva", "refresh", response);
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
    throw new Error("No access token in Canva refresh response");
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
export async function exchangeCanvaCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  state: string,
): Promise<CanvaTokenResult> {
  const codeVerifier = await deriveCodeVerifier(state);
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(CANVA_TOKEN_URL, {
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
    await throwOAuthError("Canva", "exchange", response);
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
    throw new Error("No access token in Canva response");
  }

  const userInfo = await fetchCanvaUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Fetch Canva user info using the /v1/users/me and /v1/users/me/profile endpoints.
 */
async function fetchCanvaUserInfo(accessToken: string): Promise<CanvaUserInfo> {
  const meResponse = await fetch(CANVA_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!meResponse.ok) {
    throw new Error(`Canva user info fetch failed: ${meResponse.status}`);
  }

  const meData = z
    .object({
      team_user: z
        .object({
          user_id: z.string(),
          team_id: z.string().optional(),
        })
        .optional(),
    })
    .parse(await meResponse.json());

  const userId = requireConnectorGrantUserId(
    meData.team_user?.user_id,
    "Canva",
  );

  // Fetch display name from profile endpoint (requires profile:read scope)
  let displayName: string | null = null;
  const profileResponse = await fetch(CANVA_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (profileResponse.ok) {
    const profileData = z
      .object({
        profile: z
          .object({
            display_name: z.string().nullable().optional(),
          })
          .optional(),
      })
      .parse(await profileResponse.json());

    displayName = profileData.profile?.display_name ?? null;
  }

  return {
    id: userId,
    username: displayName,
    email: null,
  };
}
