import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { buildGoogleAuthorizationUrl } from "../../oauth/google";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_OPENID_USERINFO_URL =
  "https://openidconnect.googleapis.com/v1/userinfo";

const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"];

interface GmailUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

interface GmailTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: GmailUserInfo;
}

/**
 * Build Gmail OAuth authorization URL.
 * Requests offline access to obtain a refresh token.
 */
export function buildGmailAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const scopes = [
    ...new Set([...authCodeGrant.scopes, ...GOOGLE_IDENTITY_SCOPES]),
  ];

  return buildGoogleAuthorizationUrl(
    { ...authCodeGrant, scopes },
    "gmail",
    clientId,
    redirectUri,
    state,
  );
}

/**
 * Exchange authorization code for access token and user info.
 * Google returns user info from a separate userinfo endpoint.
 */
export async function exchangeGmailCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GmailTokenResult> {
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
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
    await throwOAuthError("Gmail", "exchange", response);
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
    throw new Error("No access token in Gmail response");
  }

  const userInfo = await fetchGmailUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, " "),
    userInfo,
  };
}

/**
 * Fetch Gmail user info using Google's OpenID Connect userinfo endpoint.
 */
async function fetchGmailUserInfo(accessToken: string): Promise<GmailUserInfo> {
  const response = await fetch(GOOGLE_OPENID_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Gmail user info fetch failed: ${response.status}`);
  }

  const data = object({
    sub: string().optional(),
    email: string().nullable().optional(),
    name: string().nullable().optional(),
  }).parse(await response.json());

  // Google defines OIDC `sub` as immutable while email can change, so persist the subject and request identity scopes for compatibility. Ref: https://developers.google.com/identity/openid-connect/openid-connect
  return {
    id: requireConnectorGrantUserId(data.sub, "Gmail"),
    email: data.email ?? null,
    name: data.name ?? data.email ?? null,
  };
}
