import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { requireConnectorGrantUserId } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";

const TODOIST_TOKEN_URL = "https://todoist.com/oauth/access_token";

const TODOIST_AUTHORIZATION_URL = "https://todoist.com/oauth/authorize";

const TODOIST_USER_URL = "https://api.todoist.com/api/v1/user";

interface TodoistTokenResult {
  accessToken: string;
  scopes: string[];
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

/**
 * Build Todoist OAuth authorization URL.
 * Todoist uses comma-separated scopes.
 */
export function buildTodoistAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: authCodeGrant.scopes.join(","),
    state,
    redirect_uri: redirectUri,
  });

  return `${TODOIST_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Todoist tokens are long-lived — no refresh token is returned.
 * User info is fetched separately via the v1 User API.
 */
export async function exchangeTodoistCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TodoistTokenResult> {
  const response = await fetch(TODOIST_TOKEN_URL, {
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
    await throwOAuthError("Todoist", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Todoist OAuth error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Todoist response");
  }

  const userInfo = await fetchTodoistUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    scopes: authCodeGrant.scopes,
    userInfo,
  };
}

/**
 * Fetch user info from Todoist v1 API.
 */
async function fetchTodoistUserInfo(accessToken: string): Promise<{
  id: string;
  username: string | null;
  email: string | null;
}> {
  const response = await fetch(TODOIST_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Todoist user info fetch failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = z
    .object({
      id: z.string().optional(),
      full_name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: requireConnectorGrantUserId(data.id, "Todoist"),
    username: data.full_name ?? null,
    email: data.email ?? null,
  };
}
