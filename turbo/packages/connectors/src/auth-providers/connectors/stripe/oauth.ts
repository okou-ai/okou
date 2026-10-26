import { boolean, number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";

const STRIPE_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";

const STRIPE_AUTHORIZATION_URL =
  "https://marketplace.stripe.com/oauth/v2/authorize";

const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";

interface StripeUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface StripeTokenResult {
  accessToken: string;
  expiresIn?: number;
  livemode: boolean;
  refreshToken: string | null;
  scopes: string[];
  userInfo: StripeUserInfo;
}

interface StripeRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[] | null;
}

/**
 * Build a Stripe Marketplace OAuth authorization URL.
 * App permissions are declared in the Stripe App manifest, so this URL does
 * not include the legacy Connect response_type or scope parameters.
 */
export function buildStripeAuthorizationUrl(
  _authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  return `${STRIPE_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange a Stripe Marketplace authorization code for tokens and user info.
 * Stripe authenticates this request with the app's secret API key via HTTP
 * Basic auth rather than a client_secret form field.
 */
export async function exchangeStripeCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  _clientId: string,
  clientSecret: string,
  code: string,
): Promise<StripeTokenResult> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientSecret}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Stripe", "exchange", response);
  }

  const data = object({
    access_token: string().optional(),
    expires_in: number().optional(),
    livemode: boolean(),
    refresh_token: string().nullable().optional(),
    stripe_user_id: string().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Stripe response");
  }

  const stripeUserId = data.stripe_user_id ?? "";

  // Fetch account info for display name and email
  const userInfo = await fetchStripeAccountInfo(
    data.access_token,
    stripeUserId,
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    livemode: data.livemode,
    refreshToken: data.refresh_token ?? null,
    // Stripe reports the protocol-level scope `stripe_apps` here. The actual
    // resource permissions live in the app manifest and are declared by the
    // connector grant, so preserve those permission names on the connection.
    scopes: [...authCodeGrant.scopes],
    userInfo,
  };
}

/**
 * Refresh a Stripe Marketplace access token using its rolling refresh token.
 * Access tokens expire after one hour. Ref:
 * https://docs.stripe.com/stripe-apps/api-authentication/oauth
 */
export async function refreshStripeToken(
  _clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<StripeRefreshResult> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientSecret}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Stripe", "refresh", response);
  }

  const data = object({
    access_token: string().optional(),
    refresh_token: string().nullable().optional(),
    expires_in: number().optional(),
    error: string().optional(),
    error_description: string().optional(),
  }).parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Stripe refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    // Refresh responses report only `stripe_apps`, not manifest permissions.
    // Omit scopes so the platform retains the permissions stored at grant.
    scopes: null,
  };
}

/**
 * Fetch Stripe account info for the connected account.
 */
async function fetchStripeAccountInfo(
  accessToken: string,
  stripeUserId: string,
): Promise<StripeUserInfo> {
  const response = await fetch(STRIPE_ACCOUNT_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    // Fall back to just the stripe_user_id if account fetch fails
    return {
      id: stripeUserId,
      username: null,
      email: null,
    };
  }

  const data = object({
    id: string().optional(),
    business_profile: object({
      name: string().nullable().optional(),
    })
      .nullable()
      .optional(),
    email: string().nullable().optional(),
  }).parse(await response.json());

  return {
    id: data.id ?? stripeUserId,
    username: data.business_profile?.name ?? null,
    email: data.email ?? null,
  };
}
