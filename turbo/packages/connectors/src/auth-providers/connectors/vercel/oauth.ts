import { number, object, string } from "zod";

import {
  OAuthProviderHttpError,
  standardOAuthErrorCode,
  throwOAuthError,
} from "../../oauth/error";
import { ProviderResponseError } from "../../provider-error";

const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

interface VercelUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface VercelTokenResult {
  accessToken: string;
  installationId: string | null;
}

const installationIdSchema = string().startsWith("icfg_").min(6);
const installationTokenSchema = object({
  access_token: string().min(1),
  expires_in: number().int().positive(),
  scope: string().optional(),
});

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

  const data = object({
    access_token: string().optional(),
    token_type: string().optional(),
    installation_id: string().nullable().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Vercel response");
  }

  return {
    accessToken: data.access_token,
    installationId: data.installation_id ?? null,
  };
}

export async function requestVercelInstallationToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly installationId: string | null;
  },
  signal?: AbortSignal,
): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
  const installationId = installationIdSchema.safeParse(args.installationId);
  if (!installationId.success) {
    throw new ProviderResponseError(
      "Missing or invalid Vercel installation ID",
    );
  }

  const response = await fetch(VERCEL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      grant_type: "client_credentials",
      installation_id: installationId.data,
    }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
  if (!response.ok) {
    const failure = object({
      code: string().optional(),
      error: string().optional(),
    }).safeParse(payload);
    throw new OAuthProviderHttpError(
      `Vercel installation token request failed: ${response.status}`,
      response.status,
      standardOAuthErrorCode(failure.data?.code ?? failure.data?.error),
    );
  }

  const token = installationTokenSchema.safeParse(payload);
  if (!token.success) {
    throw new ProviderResponseError(
      "Invalid Vercel installation token response",
    );
  }
  return {
    accessToken: token.data.access_token,
    expiresIn: token.data.expires_in,
    ...(token.data.scope === undefined ? {} : { scope: token.data.scope }),
  };
}

/**
 * Fetch the authenticated Vercel user's profile via the REST API.
 */
export async function fetchVercelUserInfo(
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

  const data = object({
    user: object({
      id: string(),
      username: string().nullable().optional(),
      email: string().nullable().optional(),
    }),
  }).parse(await response.json());

  return {
    id: data.user.id,
    username: data.user.username ?? null,
    email: data.user.email ?? null,
  };
}
