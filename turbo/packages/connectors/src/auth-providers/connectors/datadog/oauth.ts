import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const AUTHORIZATION_URL = "https://app.datadoghq.com/oauth2/v1/authorize";
const DATADOG_DOMAINS = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
]);

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}

function parseDatadogDomain(oauthContext: string | undefined): string {
  if (!oauthContext) {
    throw new Error("Datadog domain missing from OAuth callback");
  }
  let context: unknown;
  try {
    context = JSON.parse(oauthContext);
  } catch {
    throw new Error("Datadog domain missing from OAuth callback");
  }
  const parsed = z
    .object({ domain: z.string() })
    .passthrough()
    .safeParse(context);
  if (!parsed.success || !DATADOG_DOMAINS.has(parsed.data.domain)) {
    throw new Error("Unsupported Datadog domain in OAuth callback");
  }
  return parsed.data.domain;
}

function tokenUrl(domain: string): string {
  if (!DATADOG_DOMAINS.has(domain)) {
    throw new Error("Unsupported Datadog domain");
  }
  return `https://api.${domain}/oauth2/v1/token`;
}

export async function buildDatadogAuthorizationUrl(
  _grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
) {
  const codeVerifier = generateCodeVerifier();
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    client_id: clientId,
    response_type: "code",
    state,
    code_challenge: await codeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZATION_URL}?${params.toString()}`, codeVerifier };
}

async function requestToken(
  args: {
    readonly domain: string;
    readonly body: URLSearchParams;
    readonly operation: "exchange" | "refresh";
  },
  signal?: AbortSignal,
) {
  const response = await fetch(tokenUrl(args.domain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: args.body,
    signal,
  });
  if (!response.ok) {
    await throwOAuthError("Datadog", args.operation, response);
  }
  return tokenSchema.parse(await response.json());
}

export async function exchangeDatadogCode(args: {
  readonly grant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | undefined;
  readonly oauthContext: string | undefined;
}) {
  if (!args.codeVerifier) {
    throw new Error("Datadog requires a PKCE code verifier");
  }
  const domain = parseDatadogDomain(args.oauthContext);
  const token = await requestToken({
    domain,
    operation: "exchange",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
      code: args.code,
    }),
  });
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, args.grant.scopes, " "),
    domain,
  };
}

export async function refreshDatadogToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
    readonly domain: string;
  },
  signal: AbortSignal,
) {
  const token = await requestToken(
    {
      domain: args.domain,
      operation: "refresh",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: args.clientId,
        client_secret: args.clientSecret,
        refresh_token: args.refreshToken,
      }),
    },
    signal,
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: reportedOAuthScopes(token.scope, " "),
  };
}
