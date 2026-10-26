import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";
import { ProviderResponseError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const RESOURCE_GURU_TOKEN_URL = "https://api.resourceguruapp.com/oauth/token";

const RESOURCE_GURU_AUTHORIZATION_URL =
  "https://api.resourceguruapp.com/oauth/authorize";

const RESOURCE_GURU_USER_URL = "https://api.resourceguruapp.com/v1/me";

interface ResourceGuruUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface ResourceGuruTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
  readonly scopes: string[];
  readonly userInfo: ResourceGuruUserInfo;
}

interface ResourceGuruRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
  readonly scopes: string[] | null;
}

const tokenResponseSchema = object({
  access_token: string().optional(),
  refresh_token: string().nullable().optional(),
  expires_in: number().optional(),
  scope: string().optional(),
  token_type: string().optional(),
  error: string().optional(),
  error_description: string().optional(),
});

/** Build the Resource Guru OAuth authorization URL. */
export function buildResourceGuruAuthorizationUrl(
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

  return `${RESOURCE_GURU_AUTHORIZATION_URL}?${params.toString()}`;
}

/** Exchange an authorization code and resolve the authenticated user. */
export async function exchangeResourceGuruCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<ResourceGuruTokenResult> {
  const response = await fetch(RESOURCE_GURU_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Resource Guru", "exchange", response);
  }

  const data = await parseProviderTokenResponse(
    response,
    tokenResponseSchema,
    "Invalid Resource Guru token response",
  );
  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new ProviderResponseError(
      "No access token in Resource Guru response",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo: await fetchResourceGuruUserInfo(data.access_token),
  };
}

/** Refresh a Resource Guru access token using the rotated refresh token. */
export async function refreshResourceGuruToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<ResourceGuruRefreshResult> {
  const response = await fetch(RESOURCE_GURU_TOKEN_URL, {
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
    await throwOAuthError("Resource Guru", "refresh", response);
  }

  const data = await parseProviderTokenResponse(
    response,
    tokenResponseSchema,
    "Invalid Resource Guru token response",
  );
  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new ProviderResponseError(
      "No access token in Resource Guru refresh response",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

async function fetchResourceGuruUserInfo(
  accessToken: string,
): Promise<ResourceGuruUserInfo> {
  const response = await fetch(RESOURCE_GURU_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Resource Guru user info fetch failed: ${response.status}`);
  }

  const data = object({
    id: number().int().positive(),
    first_name: string(),
    last_name: string(),
    email: string(),
  }).parse(await response.json());

  const name = [data.first_name, data.last_name]
    .map((part) => {
      return part.trim();
    })
    .filter(Boolean)
    .join(" ");

  return {
    id: String(data.id),
    username: name || data.email,
    email: data.email,
  };
}
