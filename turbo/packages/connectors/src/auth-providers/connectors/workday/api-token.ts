import { number, object, string } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const WORKDAY_HOST = /^[a-z0-9.-]+\.(?:myworkday|workday)\.com$/i;
const TENANT = /^[a-z0-9_-]+$/i;

export async function refreshWorkdayAccessToken(
  args: {
    readonly host: string;
    readonly tenant: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
) {
  if (!WORKDAY_HOST.test(args.host) || !TENANT.test(args.tenant)) {
    throw new Error("Invalid Workday host or tenant alias");
  }
  const tokenUrl = `https://${args.host.toLowerCase()}/ccx/oauth2/${args.tenant}/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Workday access token refresh failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = object({
    access_token: string().min(1),
    refresh_token: string().min(1).optional(),
    expires_in: number().positive().optional(),
  }).safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Workday token response");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
  };
}
