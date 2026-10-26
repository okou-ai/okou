import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

const GITHUB_AUTHORIZATION_URL = "https://github.com/login/oauth/authorize";

const GITHUB_API_BASE = "https://api.github.com";

interface GitHubUserInfo {
  id: string;
  username: string;
  email: string | null;
}

/**
 * Build GitHub OAuth authorization URL
 */
export function buildGitHubAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: authCodeGrant.scopes.join(" "),
    state,
  });

  return `${GITHUB_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeGitHubCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri?: string,
): Promise<{ accessToken: string; scopes: string[] }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  }

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    await throwOAuthError("GitHub", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    scope: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in GitHub response");
  }

  return {
    accessToken: data.access_token,
    scopes: effectiveOAuthScopes(data.scope, authCodeGrant.scopes, ","),
  };
}

/**
 * Fetch GitHub user info using access token
 */
export async function fetchGitHubUserInfo(
  accessToken: string,
): Promise<GitHubUserInfo> {
  const response = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user API failed: ${response.status}`);
  }

  const data = object({
    id: number(),
    login: string(),
    email: string().nullable(),
  }).parse(await response.json());

  return {
    id: String(data.id),
    username: data.login,
    email: data.email,
  };
}

/**
 * Revoke GitHub OAuth app authorization grant.
 * Uses the grant revocation endpoint (not token) to force re-consent on next connect.
 * Ref: https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization
 */
export async function revokeGitHubGrant(
  clientId: string,
  clientSecret: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `${GITHUB_API_BASE}/applications/${clientId}/grant`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub grant revocation failed: ${response.status}`);
  }
}

/**
 * Get the primary secret name for GitHub connector (the access token).
 * Uses an explicit key rather than Object.keys() ordering to avoid
 * fragile dependency on property insertion order.
 */
export function getGitHubSecretName(): string {
  return "GITHUB_ACCESS_TOKEN";
}
