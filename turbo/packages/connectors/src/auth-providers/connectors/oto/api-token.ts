import { boolean, number, object, string, union } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const OTO_REFRESH_TOKEN_URL = "https://api.tryoto.com/rest/v2/refreshToken";

const otoRefreshTokenResponseSchema = object({
  access_token: string().min(1),
  refresh_token: string().min(1).optional(),
  token_type: string().min(1).optional(),
  success: boolean().optional(),
  expires_in: union([
    number().positive(),
    string()
      .regex(/^[1-9][0-9]*$/u)
      .transform(Number),
  ]).refine((value) => {
    return value > 0;
  }),
});

interface OtoAccessTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export async function fetchOtoAccessToken(
  args: { readonly refreshToken: string },
  signal: AbortSignal,
): Promise<OtoAccessTokenResult> {
  const response = await fetch(OTO_REFRESH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: args.refreshToken }),
    signal,
  });

  if (!response.ok) {
    throw new ProviderHttpError(
      `OTO access token request failed: ${response.status}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderResponseError("Invalid OTO access token response");
  }

  const parsed = otoRefreshTokenResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.success === false) {
    throw new ProviderResponseError("Invalid OTO access token response");
  }
  if (
    parsed.data.token_type !== undefined &&
    parsed.data.token_type.toLowerCase() !== "bearer"
  ) {
    throw new ProviderResponseError("Invalid OTO access token response");
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? args.refreshToken,
    expiresIn: parsed.data.expires_in,
  };
}
