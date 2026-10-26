import { number, object, string } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const PROCOUNTOR_TOKEN_URL = "https://api.procountor.com/api/oauth/token";

interface ProcountorTokenResult {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export async function fetchProcountorAccessToken(
  args: {
    readonly apiKey: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<ProcountorTokenResult> {
  const response = await fetch(PROCOUNTOR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      api_key: args.apiKey,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Procountor access token request failed: ${response.status}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderResponseError("Invalid Procountor access token response");
  }
  const parsed = object({
    access_token: string().min(1),
    expires_in: number().positive(),
  }).safeParse(payload);
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Procountor access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
  };
}
