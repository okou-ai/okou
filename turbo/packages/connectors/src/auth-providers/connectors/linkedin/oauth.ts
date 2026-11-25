import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { ProviderHttpError } from "../../provider-error";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";

const AUTHORIZATION_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

export function buildLinkedInAuthorizationUrl(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return `${AUTHORIZATION_URL}?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: grant.scopes.join(" "),
    state,
  }).toString()}`;
}

export async function exchangeLinkedInCode(args: {
  readonly grant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("LinkedIn", "exchange", response);
  }
  const token = object({
    access_token: string().min(1),
    expires_in: number().int().positive(),
    scope: string().optional(),
  }).parse(await response.json());

  const profileResponse = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) {
    throw new ProviderHttpError(
      `LinkedIn userinfo request failed: ${profileResponse.status}`,
      profileResponse.status,
    );
  }
  const profile = object({
    sub: string().min(1),
    name: string().optional(),
    email: string().optional(),
  }).parse(await profileResponse.json());

  return {
    accessToken: token.access_token,
    expiresIn: token.expires_in,
    scopes: effectiveOAuthScopes(token.scope, args.grant.scopes, " "),
    userInfo: {
      id: profile.sub,
      username: profile.name ?? null,
      email: profile.email ?? null,
    },
  };
}
