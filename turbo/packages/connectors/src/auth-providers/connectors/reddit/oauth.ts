import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

const REDDIT_AUTHORIZATION_URL = "https://www.reddit.com/api/v1/authorize";

const REDDIT_USER_INFO_URL = "https://oauth.reddit.com/api/v1/me";
const REDDIT_USER_AGENT = "web:vm0-reddit-connector:v1.0";

interface RedditUserInfo {
  id: string;
  username: string;
  email: null;
}

interface RedditTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: RedditUserInfo;
}

/**
 * Encode client credentials for Reddit Basic Auth header.
 * Reddit requires HTTP Basic Auth for token exchange (like Notion).
 */
function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

/**
 * Build Reddit OAuth authorization URL.
 * Requests permanent duration to obtain a refresh token.
 */
export function buildRedditAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    state,
    redirect_uri: redirectUri,
    duration: "permanent",
    scope: authCodeGrant.scopes.join(" "),
  });

  return `${REDDIT_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Reddit uses Basic Auth header (like Notion) with form-encoded body (like Strava).
 */
export async function exchangeRedditCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<RedditTokenResult> {
  const response = await fetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Reddit", "exchange", response);
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
    throw new Error("No access token in Reddit response");
  }

  const userInfo = await fetchRedditUserInfo(data.access_token);
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
 * Fetch Reddit user info from /api/v1/me.
 * Reddit requires a User-Agent header on all API requests.
 * Note: Reddit never provides email; only id and name are available.
 */
async function fetchRedditUserInfo(
  accessToken: string,
): Promise<RedditUserInfo> {
  const response = await fetch(REDDIT_USER_INFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": REDDIT_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Reddit user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    username: data.name,
    email: null,
  };
}

interface RedditRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Refresh a Reddit access token using the refresh token.
 * Reddit uses Basic Auth (same as token exchange) and may rotate refresh tokens.
 * Access token expires_in: 3600s (1 hour). Ref: https://github.com/reddit-archive/reddit/wiki/oauth2
 */
export async function refreshRedditToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<RedditRefreshResult> {
  const response = await fetch(REDDIT_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Reddit", "refresh", response);
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
    throw new Error("No access token in Reddit refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}
