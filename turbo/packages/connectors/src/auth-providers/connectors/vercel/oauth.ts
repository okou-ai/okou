import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";

const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

interface VercelUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface VercelTokenResult {
  accessToken: string;
  teamId: string | null;
  installationId: string | null;
  userInfo: VercelUserInfo;
}

/**
 * Build Vercel Integration OAuth authorization URL.
 */
export function buildVercelAuthorizationUrl(
  _clientId: string,
  _redirectUri: string,
  state: string,
): string {
  const slug = process.env.VERCEL_INTEGRATION_SLUG;
  if (!slug) {
    throw new Error("VERCEL_INTEGRATION_SLUG is not configured");
  }

  const params = new URLSearchParams({ state });

  return `https://vercel.com/integrations/${slug}/new?${params.toString()}`;
}

/**
 * Exchange authorization code for access token via Vercel Integration OAuth.
 */
export async function exchangeVercelCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<VercelTokenResult> {
  const response = await fetch(VERCEL_TOKEN_URL, {
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
    await throwOAuthError("Vercel", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      team_id: z.string().nullable().optional(),
      installation_id: z.string().nullable().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Vercel response");
  }

  const userInfo = await fetchVercelUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    teamId: data.team_id ?? null,
    installationId: data.installation_id ?? null,
    userInfo,
  };
}

/**
 * Fetch the authenticated Vercel user's profile via the REST API.
 */
async function fetchVercelUserInfo(
  accessToken: string,
): Promise<VercelUserInfo> {
  const response = await fetch("https://api.vercel.com/v2/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Vercel user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      user: z.object({
        id: z.string(),
        username: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }),
    })
    .parse(await response.json());

  return {
    id: data.user.id,
    username: data.user.username ?? null,
    email: data.user.email ?? null,
  };
}
