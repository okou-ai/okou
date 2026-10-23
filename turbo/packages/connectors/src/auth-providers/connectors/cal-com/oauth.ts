import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const AUTHORIZATION_URL = "https://app.cal.com/auth/oauth2/authorize";
const TOKEN_URL = "https://api.cal.com/v2/auth/oauth2/token";
const ME_URL = "https://api.cal.com/v2/me";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

export function buildCalComAuthorizationUrl(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return `${AUTHORIZATION_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: grant.scopes.join(" "),
    state,
  }).toString()}`;
}

async function requestToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
  signal?: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) {
    await throwOAuthError("Cal.com", operation, response);
  }
  return tokenSchema.parse(await response.json());
}

export async function exchangeCalComCode(args: {
  readonly grant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}) {
  const token = await requestToken(
    new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
    "exchange",
  );
  const userResponse = await fetch(ME_URL, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "cal-api-version": "2024-08-13",
    },
  });
  if (!userResponse.ok) {
    throw new Error(`Cal.com user info request failed: ${userResponse.status}`);
  }
  const user = z
    .object({
      data: z.object({
        id: z.union([z.string(), z.number()]),
        username: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      }),
    })
    .parse(await userResponse.json()).data;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, args.grant.scopes, /[ ,]+/),
    userInfo: {
      id: String(user.id),
      username: user.username ?? user.name ?? null,
      email: user.email ?? null,
    },
  };
}

export async function refreshCalComToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
) {
  const token = await requestToken(
    new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }),
    "refresh",
    signal,
  );
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresIn: token.expires_in,
    scopes: reportedOAuthScopes(token.scope, /[ ,]+/),
  };
}
