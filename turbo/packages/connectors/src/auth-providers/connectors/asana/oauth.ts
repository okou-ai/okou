import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { reportedOAuthScopes } from "../../oauth/scope";

const ASANA_TOKEN_URL = "https://app.asana.com/-/oauth_token";

const ASANA_AUTHORIZATION_URL = "https://app.asana.com/-/oauth_authorize";

const ASANA_USER_URL = "https://app.asana.com/api/1.0/users/me";

interface AsanaTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

interface AsanaRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Asana OAuth authorization URL.
 */
export function buildAsanaAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  return `${ASANA_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Asana returns a refresh token and user info (data field) in the token response.
 */
export async function exchangeAsanaCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<AsanaTokenResult> {
  const response = await fetch(ASANA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Asana", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
      data: z
        .object({
          gid: z.string(),
          name: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Asana OAuth error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Asana response");
  }

  const userInfo = data.data
    ? {
        id: data.data.gid,
        username: data.data.name ?? null,
        email: data.data.email ?? null,
      }
    : await fetchAsanaUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: authCodeGrant.scopes,
    userInfo,
  };
}

/**
 * Fetch user info from Asana API (fallback if not in token response).
 */
async function fetchAsanaUserInfo(accessToken: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
}> {
  const response = await fetch(ASANA_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Asana user info fetch failed: ${response.status} ${await response.text()}`,
    );
  }

  const body = z
    .object({
      data: z.object({
        gid: z.string(),
        name: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }),
    })
    .parse(await response.json());

  return {
    id: body.data.gid,
    username: body.data.name ?? null,
    email: body.data.email ?? null,
  };
}

/**
 * Refresh an Asana access token using the refresh token.
 * Access token expires_in: 3600s (1 hour). Ref: https://developers.asana.com/docs/oauth
 */
export async function refreshAsanaToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<AsanaRefreshResult> {
  const response = await fetch(ASANA_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Asana", "refresh", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Asana refresh error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Asana refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}
