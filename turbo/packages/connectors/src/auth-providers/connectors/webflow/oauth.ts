import { object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";

const WEBFLOW_TOKEN_URL = "https://api.webflow.com/oauth/access_token";

const WEBFLOW_AUTHORIZATION_URL = "https://webflow.com/oauth/authorize";

interface WebflowTokenResult {
  accessToken: string;
  scopes: string[];
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

/**
 * Build Webflow OAuth authorization URL.
 */
export function buildWebflowAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
    redirect_uri: redirectUri,
  });

  return `${WEBFLOW_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Webflow tokens are long-lived — no refresh token is returned.
 */
export async function exchangeWebflowCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<WebflowTokenResult> {
  const response = await fetch(WEBFLOW_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Webflow", "exchange", response);
  }

  const data = object({
    access_token: string(),
    token_type: string().optional(),
  }).parse(await response.json());

  const userInfo = await fetchWebflowUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    scopes: authCodeGrant.scopes,
    userInfo,
  };
}

/**
 * Fetch user info from Webflow API.
 */
async function fetchWebflowUserInfo(accessToken: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
}> {
  const response = await fetch(
    "https://api.webflow.com/v2/token/authorized_by",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "accept-version": "1.0.0",
      },
    },
  );

  if (!response.ok) {
    return { id: "unknown", username: null, email: null };
  }

  const data = object({
    id: string().optional(),
    email: string().nullable().optional(),
    firstName: string().nullable().optional(),
    lastName: string().nullable().optional(),
  }).parse(await response.json());

  const fullName =
    [data.firstName, data.lastName].filter(Boolean).join(" ") || null;

  return {
    id: data.id ?? "unknown",
    username: fullName,
    email: data.email ?? null,
  };
}
