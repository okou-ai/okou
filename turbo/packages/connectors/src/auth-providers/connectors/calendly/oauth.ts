import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const TOKEN_URL = "https://auth.calendly.com/oauth/token";
const tokenResponseSchema = z.object({
  token_type: z.literal("Bearer"),
  access_token: z.string().min(1),
  // Calendly rotates single-use refresh tokens on every successful exchange.
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function buildCalendlyAuthorizationUrl(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: grant.scopes.join(" "),
    state,
    code_challenge: base64Url(new Uint8Array(challenge)),
    code_challenge_method: "S256",
  });
  return {
    url: `https://auth.calendly.com/oauth/authorize?${params.toString()}`,
    codeVerifier,
  };
}

export async function exchangeCalendlyCode(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string | undefined,
) {
  if (!codeVerifier) {
    throw new Error("Calendly requires the original PKCE code verifier");
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("Calendly", "exchange", response);
  }
  const token = tokenResponseSchema.parse(await response.json());
  const userResponse = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userResponse.ok) {
    throw new Error(`Calendly user info fetch failed: ${userResponse.status}`);
  }
  const { resource } = z
    .object({
      resource: z.object({
        uri: z.url().startsWith("https://api.calendly.com/users/"),
        name: z.string(),
        email: z.string(),
      }),
    })
    .parse(await userResponse.json());
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, grant.scopes, " "),
    userInfo: {
      id: resource.uri,
      username: resource.name,
      email: resource.email,
    },
  };
}

export async function refreshCalendlyToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("Calendly", "refresh", response);
  }
  const token = tokenResponseSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    scopes: reportedOAuthScopes(token.scope, " "),
  };
}

export async function revokeCalendlyToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("https://auth.calendly.com/oauth/revoke", {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      token: refreshToken,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("Calendly", "revoke", response);
  }
}
