import { number, object, string } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const TOKEN_URL = "https://accounts.noyo.com/auth/public/token";

const noyoAccessTokenResponseSchema = object({
  access_token: string().min(1),
  expires_in: number().positive(),
});

export async function fetchNoyoAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
  },
  signal: AbortSignal,
): Promise<{ readonly accessToken: string; readonly expiresIn: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Noyo access token request failed: ${response.status}`,
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProviderResponseError("Invalid Noyo access token response");
    }
    throw error;
  }
  const parsed = noyoAccessTokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Noyo access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    // Noyo reports milliseconds; connector providers expose expiry in seconds.
    expiresIn: parsed.data.expires_in / 1000,
  };
}
