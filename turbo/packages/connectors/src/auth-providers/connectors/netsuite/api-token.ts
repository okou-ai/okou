import * as z from "zod";

import { ProviderHttpError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";

const ACCOUNT_SUBDOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export async function refreshNetSuiteAccessToken(
  args: {
    readonly accountSubdomain: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
) {
  if (!ACCOUNT_SUBDOMAIN.test(args.accountSubdomain)) {
    throw new Error("Invalid NetSuite account domain prefix");
  }
  const tokenUrl = `https://${args.accountSubdomain.toLowerCase()}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
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
      `NetSuite access token refresh failed: ${response.status}`,
      response.status,
    );
  }
  const data = await parseProviderTokenResponse(
    response,
    z.object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive().optional(),
    }),
    "Invalid NetSuite token response",
  );
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
