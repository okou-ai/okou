import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";
import { ProviderHttpError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const API_BASE = "https://api.ramp.com/developer/v1";
const TOKEN_URL = `${API_BASE}/token`;

const tokenSchema = object({
  access_token: string().min(1),
  expires_in: number().int().positive(),
  token_type: string().regex(/^bearer$/iu),
  scope: string().optional(),
});

function clientHeaders(clientId: string, clientSecret: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

// Ramp's authorization guide specifies the App host for interactive consent.
// https://docs.ramp.com/developer-api/v1/authorization
export function buildRampAuthorizationUrl(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("https://app.ramp.com/v1/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: grant.scopes.join(" "),
  }).toString();
  return url.toString();
}

export async function exchangeRampCode(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: clientHeaders(clientId, clientSecret),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Ramp token exchange failed: ${response.status}`,
      response.status,
    );
  }
  const token = await parseProviderTokenResponse(
    response,
    tokenSchema.extend({ refresh_token: string().min(1) }),
    "Invalid Ramp token exchange response",
  );
  const businessResponse = await fetch(`${API_BASE}/business`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json",
    },
  });
  if (!businessResponse.ok) {
    throw new ProviderHttpError(
      `Ramp business lookup failed: ${businessResponse.status}`,
      businessResponse.status,
    );
  }
  const business = await parseProviderTokenResponse(
    businessResponse,
    object({
      id: string().min(1),
      business_name_legal: string().nullable().optional(),
    }),
    "Invalid Ramp business response",
  );
  return {
    outputs: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    },
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, grant.scopes, " "),
    userInfo: {
      id: requireConnectorGrantUserId(business.id, "Ramp"),
      username: business.business_name_legal ?? null,
      email: null,
    },
  };
}

export async function refreshRampToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: clientHeaders(clientId, clientSecret),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Ramp token refresh failed: ${response.status}`,
      response.status,
    );
  }
  const token = await parseProviderTokenResponse(
    response,
    tokenSchema.extend({ refresh_token: string().min(1).optional() }),
    "Invalid Ramp token refresh response",
  );
  return {
    accessToken: token.access_token,
    // Ramp normally omits this on refresh; the shared adapter preserves the
    // stored refresh token. Refreshing does not extend that token's lifetime.
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: reportedOAuthScopes(token.scope, " "),
  };
}

export async function revokeRampToken(
  clientId: string,
  clientSecret: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${TOKEN_URL}/revoke`, {
    method: "POST",
    headers: clientHeaders(clientId, clientSecret),
    body: new URLSearchParams({ token }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Ramp token revocation failed: ${response.status}`,
      response.status,
    );
  }
}
