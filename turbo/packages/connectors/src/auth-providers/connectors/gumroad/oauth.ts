import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const GUMROAD_TOKEN_URL = "https://gumroad.com/oauth/token";

const GUMROAD_AUTHORIZATION_URL = "https://gumroad.com/oauth/authorize";

const GUMROAD_USER_URL = "https://api.gumroad.com/v2/user";

interface GumroadUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface GumroadTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GumroadUserInfo;
}

interface GumroadRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

export function buildGumroadAuthorizationUrl(
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

  return `${GUMROAD_AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeGumroadCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GumroadTokenResult> {
  const response = await fetch(GUMROAD_TOKEN_URL, {
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
    await throwOAuthError("Gumroad", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().nullable().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Gumroad response");
  }

  const userInfo = await fetchGumroadUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? undefined,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

export async function refreshGumroadToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<GumroadRefreshResult> {
  const response = await fetch(GUMROAD_TOKEN_URL, {
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
    await throwOAuthError("Gumroad", "refresh", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().nullable().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Gumroad refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? undefined,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

async function fetchGumroadUserInfo(
  accessToken: string,
): Promise<GumroadUserInfo> {
  const response = await fetch(GUMROAD_USER_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Gumroad user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      user: z
        .object({
          id: z.string().optional(),
          name: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.user?.id, "Gumroad"),
    username: data.user?.name ?? null,
    email: data.user?.email ?? null,
  };
}

export function getGumroadSecretName(): string {
  return "GUMROAD_ACCESS_TOKEN";
}
