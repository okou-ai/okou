import { z } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const POSTHOG_TOKEN_URL = "https://oauth.posthog.com/oauth/token/";
const POSTHOG_AUTHORIZATION_URL = "https://oauth.posthog.com/oauth/authorize/";

const regionSchema = z
  .object({
    region: z.enum(["us", "eu"]),
    baseUrl: z.enum(["https://us.posthog.com", "https://eu.posthog.com"]),
  })
  .refine(
    ({ region, baseUrl }) => {
      return baseUrl === `https://${region}.posthog.com`;
    },
    {
      message: "PostHog region and API URL do not match",
    },
  );

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  posthog_region: z.string(),
  posthog_base_url: z.string(),
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function buildPosthogAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
) {
  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  return {
    url: `${POSTHOG_AUTHORIZATION_URL}?${params.toString()}`,
    codeVerifier,
  };
}

async function requestToken(
  url: string,
  operation: "exchange" | "refresh",
  body: URLSearchParams,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await throwOAuthError("PostHog", operation, response);
  }
  const token = tokenSchema.parse(await response.json());
  const region = regionSchema.parse({
    region: token.posthog_region,
    baseUrl: token.posthog_base_url,
  });
  return { token, ...region };
}

export async function exchangePosthogCode(args: {
  readonly grant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | undefined;
}) {
  if (!args.codeVerifier) {
    throw new Error("PostHog requires the original PKCE code verifier");
  }
  const { token, region, baseUrl } = await requestToken(
    POSTHOG_TOKEN_URL,
    "exchange",
    new URLSearchParams({
      client_id: args.clientId,
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      grant_type: "authorization_code",
    }),
  );
  const userInfo = await fetchPosthogUserInfo(baseUrl, token.access_token);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, args.grant.scopes, " "),
    region,
    baseUrl,
    userInfo,
  };
}

export async function refreshPosthogToken(
  args: {
    readonly clientId: string;
    readonly refreshToken: string;
    readonly region: string;
    readonly baseUrl: string;
  },
  signal: AbortSignal,
) {
  const savedRegion = regionSchema.parse(args);
  // Refresh against the account's region: the shared OAuth proxy's region
  // selection can change when another account authorizes the same client_id.
  const { token, region, baseUrl } = await requestToken(
    `${savedRegion.baseUrl}/oauth/token/`,
    "refresh",
    new URLSearchParams({
      client_id: args.clientId,
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }),
    signal,
  );
  if (region !== savedRegion.region || baseUrl !== savedRegion.baseUrl) {
    throw new Error("PostHog refresh response changed the account region");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: reportedOAuthScopes(token.scope, " "),
  };
}

async function fetchPosthogUserInfo(baseUrl: string, accessToken: string) {
  const response = await fetch(`${baseUrl}/api/users/@me/`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`PostHog user info fetch failed: ${response.status}`);
  }
  const data = z
    .object({
      id: z.number(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
    })
    .parse(await response.json());
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ");
  return {
    id: String(data.id),
    name: name || null,
    email: data.email ?? null,
  };
}
