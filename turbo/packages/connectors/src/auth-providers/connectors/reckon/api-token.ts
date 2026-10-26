import { number, object, string } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const RECKON_TOKEN_URL = "https://identity.reckon.com/connect/token";

interface ReckonTokenResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

export async function refreshReckonAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<ReckonTokenResult> {
  const response = await fetch(RECKON_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      redirect_uri: args.redirectUri,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Reckon access token refresh failed: ${response.status}`,
      response.status,
    );
  }

  const data = await parseProviderTokenResponse(
    response,
    object({
      access_token: string().min(1).optional(),
      refresh_token: string().min(1).optional(),
      expires_in: number().positive().optional(),
      error: string().min(1).optional(),
      error_description: string().min(1).optional(),
    }),
    "Invalid Reckon token response",
  );
  if (data.error !== undefined) {
    throw new ProviderResponseError(data.error_description ?? data.error);
  }
  if (data.access_token === undefined) {
    throw new ProviderResponseError("No access token in Reckon token response");
  }
  return {
    accessToken: data.access_token,
    ...(data.refresh_token === undefined
      ? {}
      : { refreshToken: data.refresh_token }),
    ...(data.expires_in === undefined ? {} : { expiresIn: data.expires_in }),
  };
}
