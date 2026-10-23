import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";

const AUTHORIZATION_URL = "https://app.copper.com/oauth/authorize";
const TOKEN_URL = "https://app.copper.com/oauth/token";
const ACCOUNT_URL = "https://api.copper.com/developer_api/v1/account";

export function buildCopperAuthorizationUrl(
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

export async function exchangeCopperCode(args: {
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
    await throwOAuthError("Copper", "exchange", response);
  }
  const token = z
    .object({ access_token: z.string().min(1), scope: z.string().optional() })
    .parse(await response.json());
  const accountResponse = await fetch(ACCOUNT_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!accountResponse.ok) {
    throw new Error(`Copper account request failed: ${accountResponse.status}`);
  }
  const account = z
    .object({
      id: z.union([z.string(), z.number()]),
      name: z.string().optional(),
    })
    .parse(await accountResponse.json());
  return {
    accessToken: token.access_token,
    scopes: effectiveOAuthScopes(token.scope, args.grant.scopes, " "),
    userInfo: {
      id: String(account.id),
      username: account.name ?? null,
      email: null,
    },
  };
}
