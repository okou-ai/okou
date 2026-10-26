import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const CLOUDFLARE_AUTHORIZATION_URL = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const CLOUDFLARE_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";

interface CloudflareUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface CloudflareTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: CloudflareUserInfo;
}

interface CloudflareRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
  readonly scopes: readonly string[] | null;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  return `Basic ${credentials}`;
}

function cloudflareTokenRequestHeaders(
  clientId: string,
  clientSecret: string,
): Record<string, string> {
  return {
    Authorization: basicAuthHeader(clientId, clientSecret),
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export function buildCloudflareAuthorizationUrl(
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

  return `${CLOUDFLARE_AUTHORIZATION_URL}?${params.toString()}`;
}

export async function exchangeCloudflareCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<CloudflareTokenResult> {
  const response = await fetch(CLOUDFLARE_TOKEN_URL, {
    method: "POST",
    headers: cloudflareTokenRequestHeaders(clientId, clientSecret),
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Cloudflare", "exchange", response);
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
    throw new Error("No access token in Cloudflare response");
  }
  if (!data.refresh_token) {
    throw new Error("No refresh token in Cloudflare response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo: await fetchCloudflareUserInfo(data.access_token),
  };
}

export async function refreshCloudflareToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<CloudflareRefreshResult> {
  const response = await fetch(CLOUDFLARE_TOKEN_URL, {
    signal,
    method: "POST",
    headers: cloudflareTokenRequestHeaders(clientId, clientSecret),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Cloudflare", "refresh", response);
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
    throw new Error("No access token in Cloudflare refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

export async function revokeCloudflareRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<void> {
  const response = await fetch(CLOUDFLARE_REVOKE_URL, {
    method: "POST",
    headers: cloudflareTokenRequestHeaders(clientId, clientSecret),
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Cloudflare", "revoke", response);
  }
}

async function fetchCloudflareUserInfo(
  accessToken: string,
): Promise<CloudflareUserInfo> {
  const response = await fetch(CLOUDFLARE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    await throwOAuthError("Cloudflare", "userinfo", response);
  }

  const data = object({
    sub: string().optional(),
    id: string().optional(),
    email: string().nullable().optional(),
    name: string().nullable().optional(),
    preferred_username: string().nullable().optional(),
  }).parse(await response.json());

  const id = data.sub ?? data.id;
  if (!id) {
    throw new Error("No user id in Cloudflare userinfo response");
  }

  return {
    id,
    username: data.preferred_username ?? data.name ?? data.email ?? null,
    email: data.email ?? null,
  };
}

export function getCloudflareSecretName(): string {
  return "CLOUDFLARE_ACCESS_TOKEN";
}
