import { number, object, string } from "zod";

import { ProviderHttpError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const TOKEN_URL = "https://api-m.paypal.com/v1/oauth2/token";

export async function fetchPayPalAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
  },
  signal: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `PayPal access token request failed: ${response.status}`,
      response.status,
    );
  }
  const data = await parseProviderTokenResponse(
    response,
    object({
      access_token: string().min(1),
      expires_in: number().positive(),
    }),
    "Invalid PayPal access token response",
  );
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}
