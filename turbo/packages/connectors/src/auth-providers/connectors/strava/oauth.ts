import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

const STRAVA_AUTHORIZATION_URL = "https://www.strava.com/oauth/authorize";

const STRAVA_ATHLETE_URL = "https://www.strava.com/api/v3/athlete";

interface StravaUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface StravaTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: StravaUserInfo;
}

interface StravaRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build Strava OAuth authorization URL.
 * Requests offline access via approval_prompt=force to obtain a refresh token.
 */
export function buildStravaAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(","),
    state,
    approval_prompt: "force",
  });

  return `${STRAVA_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Strava returns athlete info in the token response.
 */
export async function exchangeStravaCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<StravaTokenResult> {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Strava", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      athlete: z
        .object({
          id: z.number().optional(),
          firstname: z.string().nullable().optional(),
          lastname: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Strava response");
  }

  // Strava includes athlete info in the token response
  const athleteId = data.athlete?.id?.toString() ?? "";
  const firstName = data.athlete?.firstname ?? null;
  const lastName = data.athlete?.lastname ?? null;
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;

  // Fetch full athlete profile for additional info
  const userInfo = await fetchStravaAthleteInfo(
    data.access_token,
    athleteId,
    displayName,
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, /[ ,]+/),
    userInfo,
  };
}

/**
 * Refresh a Strava access token using the refresh token.
 * Strava rotates refresh tokens — both must be stored.
 * Access token expires_in: 21600s (6 hours). Ref: https://developers.strava.com/docs/authentication/
 */
export async function refreshStravaToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<StravaRefreshResult> {
  const response = await fetch(STRAVA_TOKEN_URL, {
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
    await throwOAuthError("Strava", "refresh", response);
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
    throw new Error("No access token in Strava refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, /[ ,]+/),
  };
}

/**
 * Fetch Strava athlete profile to get email.
 */
async function fetchStravaAthleteInfo(
  accessToken: string,
  athleteId: string,
  displayName: string | null,
): Promise<StravaUserInfo> {
  const response = await fetch(STRAVA_ATHLETE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Strava athlete info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.number().optional(),
      firstname: z.string().nullable().optional(),
      lastname: z.string().nullable().optional(),
    })
    .parse(await response.json());

  const id = data.id?.toString() ?? athleteId;
  const name =
    [data.firstname, data.lastname].filter(Boolean).join(" ") || displayName;

  return {
    id,
    username: name,
    email: null,
  };
}
