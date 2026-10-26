import { array, number, object, string, unknown as zUnknown } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";

const BOX_AUTHORIZATION_URL = "https://account.box.com/api/oauth2/authorize";

const BOX_CURRENT_USER_URL = "https://api.box.com/2.0/users/me";

interface BoxUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface BoxTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: BoxUserInfo;
}

interface BoxRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

export function buildBoxAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
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
  if (authCodeGrant.scopes.length > 0) {
    params.set("scope", authCodeGrant.scopes.join(" "));
  }

  return `${BOX_AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeBoxCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<BoxTokenResult> {
  const response = await fetch(BOX_TOKEN_URL, {
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
    await throwOAuthError("Box", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    restricted_to: array(zUnknown()).optional(),
    scope: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new Error("No access token in Box response");
  }

  const userInfo = await fetchBoxUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

export async function refreshBoxToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<BoxRefreshResult> {
  const response = await fetch(BOX_TOKEN_URL, {
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
    await throwOAuthError("Box", "refresh", response);
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
    throw new Error("No access token in Box refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

async function fetchBoxUserInfo(accessToken: string): Promise<BoxUserInfo> {
  const response = await fetch(BOX_CURRENT_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Box user info fetch failed: ${response.status}`);
  }

  const data = object({
    id: string().optional(),
    name: string().nullable().optional(),
    login: string().nullable().optional(),
  }).parse(await response.json());

  if (!data.id) {
    throw new Error("No user id in Box user info response");
  }

  return {
    id: data.id,
    username: data.name ?? data.login ?? null,
    email: data.login ?? null,
  };
}

export function getBoxSecretName(): string {
  return "BOX_ACCESS_TOKEN";
}
