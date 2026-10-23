import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth2/token";

const MONDAY_AUTHORIZATION_URL = "https://auth.monday.com/oauth2/authorize";

interface MondayUserInfo {
  id: string;
  username: string;
  email: string | null;
}

interface MondayTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: MondayUserInfo;
}

interface MondayRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";

/**
 * Build Monday.com OAuth authorization URL.
 */
export function buildMondayAuthorizationUrl(
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

  return `${MONDAY_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Monday.com returns user info via GraphQL after token exchange.
 */
export async function exchangeMondayCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MondayTokenResult> {
  const response = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Monday.com", "exchange", response);
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
    throw new Error("No access token in Monday.com response");
  }

  const userInfo = await fetchMondayUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Refresh a Monday.com access token.
 * Note: Monday.com tokens reportedly do not expire. expires_in may not be returned. Ref: https://developer.monday.com/apps/docs/oauth
 */
export async function refreshMondayToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<MondayRefreshResult> {
  const response = await fetch(MONDAY_TOKEN_URL, {
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
    await throwOAuthError("Monday.com", "refresh", response);
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
    throw new Error("No access token in Monday.com refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/**
 * Fetch Monday.com user info via GraphQL.
 */
async function fetchMondayUserInfo(
  accessToken: string,
): Promise<MondayUserInfo> {
  const response = await fetch(MONDAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    },
    body: JSON.stringify({
      query: "{ me { id name email } }",
    }),
  });

  if (!response.ok) {
    throw new Error(`Monday.com user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      data: z
        .object({
          me: z
            .object({
              id: z.union([z.string(), z.number()]).optional(),
              name: z.string().nullable().optional(),
              email: z.string().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(await response.json());

  if (data.errors?.length) {
    throw new Error(data.errors[0]?.message ?? "Unknown GraphQL error");
  }

  const me = data.data?.me;
  if (!me?.id) {
    throw new Error("No user data in Monday.com response");
  }

  return {
    id: String(me.id),
    username: me.name ?? "",
    email: me.email ?? null,
  };
}
