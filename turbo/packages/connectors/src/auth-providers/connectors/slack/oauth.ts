import { boolean, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";

const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

const SLACK_AUTHORIZATION_URL = "https://slack.com/oauth/v2/authorize";

interface SlackTokenResult {
  accessToken: string;
  scopes: string[];
  userId: string;
}

interface SlackUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

/**
 * Build Slack OAuth authorization URL.
 * Uses user_scope= (not scope=) to request user-level token.
 */
export function buildSlackAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    user_scope: authCodeGrant.scopes.join(","),
    state,
  });

  return `${SLACK_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for Slack user access token.
 * Extracts authed_user.access_token (xoxp-...), not the bot token.
 */
export async function exchangeSlackCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackTokenResult> {
  const response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Slack", "exchange", response);
  }

  const data = object({
    ok: boolean(),
    error: string().optional(),
    authed_user: object({
      id: string().optional(),
      access_token: string().optional(),
      scope: string().optional(),
    }).optional(),
  }).parse(await response.json());

  if (!data.ok) {
    throw new Error(data.error ?? "Slack token exchange returned ok=false");
  }

  if (!data.authed_user?.access_token) {
    throw new Error("No user access token in Slack response");
  }
  if (!data.authed_user.id) {
    throw new Error("No authenticated user id in Slack response");
  }

  return {
    accessToken: data.authed_user.access_token,
    scopes: effectiveOAuthScopes(
      data.authed_user.scope,
      authCodeGrant.scopes,
      ",",
    ),
    userId: data.authed_user.id,
  };
}

/**
 * Fetch Slack user info using user access token
 */
export async function fetchSlackUserInfo(
  userId: string,
  accessToken: string,
): Promise<SlackUserInfo> {
  const response = await fetch(
    `https://slack.com/api/users.info?user=${userId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Slack users.info API failed: ${response.status}`);
  }

  const data = object({
    ok: boolean(),
    error: string().optional(),
    user: object({
      id: string().optional(),
      name: string().optional(),
      real_name: string().optional(),
      profile: object({ email: string().optional() }).optional(),
    }).optional(),
  }).parse(await response.json());

  if (!data.ok) {
    throw new Error(data.error ?? "Slack users.info returned ok=false");
  }

  return {
    id: data.user?.id ?? userId,
    username: data.user?.real_name ?? data.user?.name ?? null,
    email: data.user?.profile?.email ?? null,
  };
}

/**
 * Revoke a Slack user token.
 * Ref: https://api.slack.com/methods/auth.revoke
 */
export async function revokeSlackToken(
  _clientId: string,
  _clientSecret: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack token revocation failed: ${response.status}`);
  }

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(data.error ?? "Slack token revocation returned ok=false");
  }
}

/**
 * Get the primary secret name for Slack connector (the user access token).
 */
export function getSlackSecretName(): string {
  return "SLACK_ACCESS_TOKEN";
}
