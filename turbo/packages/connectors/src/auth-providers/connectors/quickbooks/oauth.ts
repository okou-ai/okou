import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const QUICKBOOKS_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const QUICKBOOKS_AUTHORIZATION_URL =
  "https://appcenter.intuit.com/connect/oauth2";

const QUICKBOOKS_USERINFO_URL =
  "https://accounts.platform.intuit.com/v1/openid_connect/userinfo";

interface QuickBooksUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface QuickBooksTokenResult {
  accessToken: string;
  refreshToken: string | null;
  realmId: string;
  expiresIn?: number;
  scopes: string[];
  userInfo: QuickBooksUserInfo;
}

interface QuickBooksRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

export function buildQuickBooksAuthorizationUrl(
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

  return `${QUICKBOOKS_AUTHORIZATION_URL}?${params.toString()}`;
}

function basicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function parseQuickBooksRealmId(oauthContext: string | undefined): string {
  if (!oauthContext) {
    throw new Error("QuickBooks realmId missing from OAuth callback");
  }

  let context: unknown;
  try {
    context = JSON.parse(oauthContext);
  } catch {
    throw new Error("QuickBooks realmId missing from OAuth callback");
  }

  const parsed = object({
    realmId: string().min(1),
  })
    .passthrough()
    .safeParse(context);
  if (!parsed.success) {
    throw new Error("QuickBooks realmId missing from OAuth callback");
  }
  return parsed.data.realmId;
}

export async function exchangeQuickBooksCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  oauthContext: string | undefined,
): Promise<QuickBooksTokenResult> {
  const response = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("QuickBooks", "exchange", response);
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
    throw new Error("No access token in QuickBooks response");
  }

  const userInfo = await fetchQuickBooksUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    realmId: parseQuickBooksRealmId(oauthContext),
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

export async function refreshQuickBooksToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<QuickBooksRefreshResult> {
  const response = await fetch(QUICKBOOKS_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("QuickBooks", "refresh", response);
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
    throw new Error("No access token in QuickBooks refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, " "),
  };
}

async function fetchQuickBooksUserInfo(
  accessToken: string,
): Promise<QuickBooksUserInfo> {
  const response = await fetch(QUICKBOOKS_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`QuickBooks user info fetch failed: ${response.status}`);
  }

  const data = object({
    sub: string().optional(),
    email: string().nullable().optional(),
    givenName: string().nullable().optional(),
    familyName: string().nullable().optional(),
    given_name: string().nullable().optional(),
    family_name: string().nullable().optional(),
  })
    .passthrough()
    .parse(await response.json());
  const givenName = data.givenName ?? data.given_name;
  const familyName = data.familyName ?? data.family_name;
  const username = [givenName, familyName].filter(Boolean).join(" ").trim();
  // Intuit requires the immutable OIDC `sub` for account linking and explicitly forbids using mutable email addresses as identity. Ref: https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/technical-requirements
  const id = data.sub;
  if (!id) {
    throw new Error("No user id in QuickBooks user info response");
  }

  return {
    id,
    username: username || (data.email ?? null),
    email: data.email ?? null,
  };
}

export function getQuickBooksSecretName(): string {
  return "QUICKBOOKS_ACCESS_TOKEN";
}
