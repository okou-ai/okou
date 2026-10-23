import * as z from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import { throwOAuthError } from "../../oauth/error";

const INTERVALS_ICU_TOKEN_URL = "https://intervals.icu/api/oauth/token";

const INTERVALS_ICU_AUTHORIZATION_URL = "https://intervals.icu/oauth/authorize";

interface IntervalsIcuTokenResult {
  accessToken: string;
  scopes: string[];
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

/**
 * Build Intervals.icu OAuth authorization URL.
 * Scopes are comma-separated per the Intervals.icu API.
 */
export function buildIntervalsIcuAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(","),
    state,
  });

  return `${INTERVALS_ICU_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Intervals.icu embeds athlete_id and name directly in the token response.
 * Tokens are long-lived — no refresh token is returned.
 */
export async function exchangeIntervalsIcuCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<IntervalsIcuTokenResult> {
  const response = await fetch(INTERVALS_ICU_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Intervals.icu", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      athlete: z
        .object({
          id: z.string(),
          name: z.string().nullable().optional(),
        })
        .optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Intervals.icu response");
  }

  if (!data.athlete) {
    throw new Error("No athlete in Intervals.icu response");
  }

  return {
    accessToken: data.access_token,
    scopes: authCodeGrant.scopes,
    userInfo: {
      id: data.athlete.id,
      username: data.athlete.name ?? null,
      email: null,
    },
  };
}
