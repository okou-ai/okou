import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { reportedOAuthScopes } from "../../oauth/scope";

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

const NOTION_AUTHORIZATION_URL = "https://api.notion.com/v1/oauth/authorize";

interface NotionUserInfo {
  id: string;
  username: string;
  email: string | null;
}

interface NotionTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: NotionUserInfo;
}

interface NotionRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Encode client credentials for Notion Basic Auth header
 */
function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return btoa(`${clientId}:${clientSecret}`);
}

/**
 * Build Notion OAuth authorization URL
 */
export function buildNotionAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    owner: "user",
  });

  return `${NOTION_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Notion uses Basic Auth and JSON body (unlike GitHub's form-encoded body).
 * User info is embedded in the token response (no separate API call needed).
 */
export async function exchangeNotionCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<NotionTokenResult> {
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Notion", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      owner: z
        .object({
          user: z
            .object({
              id: z.string().optional(),
              name: z.string().nullable().optional(),
              person: z.object({ email: z.string().optional() }).optional(),
            })
            .optional(),
        })
        .optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Notion response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: [],
    userInfo: {
      id: data.owner?.user?.id ?? "",
      username: data.owner?.user?.name ?? "",
      email: data.owner?.user?.person?.email ?? null,
    },
  };
}

/**
 * Refresh a Notion access token using the refresh token.
 * Returns new access token and new refresh token (both must be stored).
 * Note: Notion does not return expires_in. Token lifetime ~1 hour (undocumented). Ref: https://developers.notion.com/reference/refresh-a-token
 */
export async function refreshNotionToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<NotionRefreshResult> {
  const response = await fetch(NOTION_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Notion", "refresh", response);
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
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Notion refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}
