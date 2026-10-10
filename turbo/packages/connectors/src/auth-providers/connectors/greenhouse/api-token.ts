import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const TOKEN_URL = "https://auth.greenhouse.io/token";

const greenhouseAccessTokenResponseSchema = z.object({
  token_type: z.string().regex(/^Bearer$/i),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

export async function fetchGreenhouseAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<{ readonly accessToken: string; readonly expiresIn: number }> {
  signal.throwIfAborted();
  if (!/^\d+$/.test(args.userId)) {
    throw new ProviderResponseError("Invalid Greenhouse authorizing user ID");
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      sub: args.userId,
    }),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Greenhouse access token request failed: ${response.status}`,
      response.status,
    );
  }
  const token = await parseProviderTokenResponse(
    response,
    greenhouseAccessTokenResponseSchema,
    "Invalid Greenhouse access token response",
  );
  return {
    accessToken: token.access_token,
    expiresIn: token.expires_in,
  };
}
