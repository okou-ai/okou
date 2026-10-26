import { number, object, string, type infer as zInfer } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";
import { ProviderResponseError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const OPTIMIZELY_CMP_AUTHORIZATION_URL =
  "https://accounts.cmp.optimizely.com/o/oauth2/v1/auth";
const OPTIMIZELY_CMP_TOKEN_URL =
  "https://accounts.cmp.optimizely.com/o/oauth2/v1/token";
const OPTIMIZELY_CMP_USERINFO_URL =
  "https://accounts.cmp.optimizely.com/o/oauth2/v1/userinfo";
// Optimizely's current CMP documentation specifies the legacy hostname for
// RFC 7009 revocation while the authorization and token endpoints use the
// current accounts.cmp.optimizely.com hostname.
const OPTIMIZELY_CMP_REVOKE_URL =
  "https://accounts.welcomesoftware.com/o/oauth2/v1/revoke";

interface OptimizelyCmpUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface OptimizelyCmpTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn?: number;
  readonly scopes: readonly string[];
  readonly userInfo: OptimizelyCmpUserInfo;
}

interface OptimizelyCmpRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn?: number;
  readonly scopes: readonly string[] | null;
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

type TokenRequest = Readonly<Record<string, string>>;

async function requestToken(
  body: TokenRequest,
  operation: "exchange" | "refresh",
  signal?: AbortSignal,
): Promise<zInfer<typeof tokenResponseSchema>> {
  const response = await fetch(OPTIMIZELY_CMP_TOKEN_URL, {
    ...(signal === undefined ? {} : { signal }),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwOAuthError("Optimizely CMP", operation, response);
  }

  const data = await parseProviderTokenResponse(
    response,
    tokenResponseSchema,
    "Invalid Optimizely CMP token response",
  );
  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  return data;
}

/** Build the Optimizely CMP authorization URL. */
export function buildOptimizelyCmpAuthorizationUrl(
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

  return `${OPTIMIZELY_CMP_AUTHORIZATION_URL}?${params.toString()}`;
}

/** Exchange an authorization code and resolve the authorized CMP user. */
export async function exchangeOptimizelyCmpCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OptimizelyCmpTokenResult> {
  const data = await requestToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    "exchange",
  );

  if (!data.access_token) {
    throw new ProviderResponseError(
      "No access token in Optimizely CMP response",
    );
  }
  if (!data.refresh_token) {
    throw new ProviderResponseError(
      "No refresh token in Optimizely CMP response",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo: await fetchOptimizelyCmpUserInfo(data.access_token),
  };
}

/** Refresh the access token and preserve CMP's single-use token rotation. */
export async function refreshOptimizelyCmpToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<OptimizelyCmpRefreshResult> {
  const data = await requestToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    "refresh",
    signal,
  );

  if (!data.access_token) {
    throw new ProviderResponseError(
      "No access token in Optimizely CMP refresh response",
    );
  }
  if (!data.refresh_token) {
    throw new ProviderResponseError(
      "No rotated refresh token in Optimizely CMP refresh response",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

/** Revoke the single-use refresh token through CMP's documented endpoint. */
export async function revokeOptimizelyCmpRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(OPTIMIZELY_CMP_REVOKE_URL, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Optimizely CMP", "revoke", response);
  }
}

async function fetchOptimizelyCmpUserInfo(
  accessToken: string,
): Promise<OptimizelyCmpUserInfo> {
  const response = await fetch(OPTIMIZELY_CMP_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    await throwOAuthError("Optimizely CMP", "userinfo", response);
  }

  const data = object({
    sub: string().optional(),
    name: string().nullable().optional(),
    preferred_username: string().nullable().optional(),
    email: string().nullable().optional(),
  }).parse(await response.json());

  if (!data.sub) {
    throw new Error("No user id in Optimizely CMP userinfo response");
  }

  return {
    id: data.sub,
    username: data.preferred_username ?? data.name ?? data.email ?? null,
    email: data.email ?? null,
  };
}
