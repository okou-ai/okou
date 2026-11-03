import { number, object, string } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";
import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import { parseProviderTokenResponse } from "../../token-response";
import { throwOAuthError } from "../../oauth/error";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
const PROFILE_URL = "https://open.tiktokapis.com/v2/user/info/";

const tokenSchema = object({
  access_token: string().min(1),
  refresh_token: string().min(1),
  expires_in: number().int().positive(),
  open_id: string().min(1),
  scope: string(),
});

interface TikTokClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function buildTikTokAuthorizationUrl(
  grant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return `https://www.tiktok.com/v2/auth/authorize/?${new URLSearchParams({
    client_key: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: grant.scopes.join(","),
    state,
  })}`;
}

async function requestToken(
  client: TikTokClient,
  parameters: Readonly<Record<string, string>>,
  operation: "exchange" | "refresh",
  signal?: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: client.clientId,
      client_secret: client.clientSecret,
      ...parameters,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("TikTok", operation, response);
  }
  const token = await parseProviderTokenResponse(
    response,
    tokenSchema,
    "Invalid TikTok token response",
  );
  return {
    outputs: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    },
    expiresIn: token.expires_in,
    scopes: token.scope.split(",").filter(Boolean),
    openId: token.open_id,
  };
}

export async function exchangeTikTokCode(
  args: TikTokClient & {
    readonly code: string;
    readonly redirectUri: string;
  },
) {
  const token = await requestToken(
    args,
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    },
    "exchange",
  );
  const response = await fetch(
    `${PROFILE_URL}?${new URLSearchParams({ fields: "open_id,display_name" })}`,
    { headers: { Authorization: `Bearer ${token.outputs.accessToken}` } },
  );
  if (!response.ok) {
    throw new ProviderHttpError(
      "TikTok profile request failed",
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProviderResponseError("Invalid TikTok profile response", {
        stage: "profile",
        reason: "invalid_json",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
      });
    }
    throw error;
  }
  const parsed = object({
    data: object({
      user: object({
        open_id: string().min(1),
        display_name: string(),
      }).optional(),
    }).optional(),
    error: object({ code: string() }),
  }).safeParse(payload);
  if (!parsed.success) {
    throw new ProviderResponseError(
      "Invalid TikTok profile response",
      {
        stage: "profile",
        reason: "invalid_schema",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        invalidFields: parsed.error.issues.map((issue) => {
          return issue.path.map(String).join(".");
        }),
      },
      payload,
    );
  }
  const profile = parsed.data;
  const user = profile.data?.user;
  if (profile.error.code !== "ok") {
    throw new ProviderResponseError(
      "Invalid TikTok profile response",
      {
        stage: "profile",
        reason: "provider_error",
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        providerCode: profile.error.code,
      },
      payload,
    );
  }
  if (!user) {
    throw new ProviderResponseError("Invalid TikTok profile response", {
      stage: "profile",
      reason: "invalid_schema",
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      invalidFields: ["data.user"],
    });
  }
  if (user.open_id !== token.openId) {
    throw new ProviderResponseError("Invalid TikTok profile response", {
      stage: "profile",
      reason: "identity_mismatch",
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
    });
  }
  return {
    outputs: token.outputs,
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: { id: user.open_id, username: user.display_name, email: null },
  };
}

export async function refreshTikTokToken(
  args: TikTokClient & { readonly refreshToken: string },
  signal: AbortSignal,
) {
  const token = await requestToken(
    args,
    { grant_type: "refresh_token", refresh_token: args.refreshToken },
    "refresh",
    signal,
  );
  return {
    outputs: token.outputs,
    expiresIn: token.expiresIn,
    scopes: token.scopes,
  };
}

export async function revokeTikTokToken(
  args: TikTokClient & { readonly accessToken: string },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(REVOKE_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: args.clientId,
      client_secret: args.clientSecret,
      token: args.accessToken,
    }),
  });
  if (!response.ok) {
    await throwOAuthError("TikTok", "revoke", response);
  }
}
