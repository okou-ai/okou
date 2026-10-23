import * as z from "zod";

import type { OAuthRefreshResult } from "../../oauth/types";
import type {
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthIncompleteResult,
  OAuthDeviceAuthStartResult,
} from "../../provider-flow-types";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes, reportedOAuthScopes } from "../../oauth/scope";

const BASE44_DEVICE_AUTH_URL = "https://app.base44.com/oauth/device/code";
const BASE44_TOKEN_URL = "https://app.base44.com/oauth/token";
const BASE44_USERINFO_URL = "https://app.base44.com/oauth/userinfo";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const deviceAuthResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const tokenErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const userInfoResponseSchema = z
  .object({
    sub: z.string().optional(),
    id: z.string().optional(),
    user_id: z.string().optional(),
    account_id: z.string().optional(),
    preferred_username: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

function devicePollErrorResult(args: {
  readonly error: string;
  readonly errorDescription: string | undefined;
}): OAuthDeviceAuthIncompleteResult {
  if (args.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (args.error === "slow_down") {
    return { status: "slow_down" };
  }
  if (args.error === "access_denied") {
    return {
      status: "denied",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  if (args.error === "expired_token") {
    return {
      status: "expired",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  return {
    status: "error",
    error: args.error,
    errorDescription: args.errorDescription,
  };
}

function requireAccessToken(
  data: z.infer<typeof tokenResponseSchema>,
  operation: string,
): string {
  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }
  if (!data.access_token) {
    throw new Error(`No access token in Base44 ${operation} response`);
  }
  return data.access_token;
}

export async function startBase44DeviceAuth(args: {
  readonly clientId: string;
  readonly scopes: readonly string[];
}): Promise<OAuthDeviceAuthStartResult> {
  const response = await fetch(BASE44_DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      scope: args.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "device authorization start", response);
  }

  const data = deviceAuthResponseSchema.parse(await response.json());
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export async function pollBase44DeviceAuth(args: {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly scopes: readonly string[];
}): Promise<OAuthDeviceAuthPollResult<"base44", "oauth">> {
  const response = await fetch(BASE44_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      client_id: args.clientId,
      device_code: args.deviceCode,
    }),
  });

  if (!response.ok) {
    const diagnosticResponse = response.clone();
    const errorParse = tokenErrorResponseSchema.safeParse(
      await response.json().catch(() => {
        return null;
      }),
    );
    if (!errorParse.success) {
      return await throwOAuthError(
        "Base44",
        "device authorization poll",
        diagnosticResponse,
      );
    }
    return devicePollErrorResult({
      error: errorParse.data.error,
      errorDescription: errorParse.data.error_description,
    });
  }

  const data = tokenResponseSchema.parse(await response.json());
  const accessToken = requireAccessToken(data, "device authorization poll");
  const userInfo = await fetchBase44UserInfo(accessToken);

  return {
    status: "complete",
    token: {
      outputs: {
        accessToken,
        refreshToken: data.refresh_token ?? null,
      },
      expiresIn: data.expires_in,
      scopes: effectiveOAuthScopes(data.scope, args.scopes, /\s+/),
      userInfo,
    },
  };
}

export async function refreshBase44Token(
  args: {
    readonly clientId: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<OAuthRefreshResult> {
  const response = await fetch(BASE44_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: args.clientId,
      refresh_token: args.refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "refresh", response);
  }

  const data = tokenResponseSchema.parse(await response.json());
  return {
    accessToken: requireAccessToken(data, "refresh"),
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: reportedOAuthScopes(data.scope, /\s+/),
  };
}

async function fetchBase44UserInfo(
  accessToken: string,
): Promise<ConnectorAuthProviderGrantUserInfo> {
  const response = await fetch(BASE44_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    await throwOAuthError("Base44", "userinfo", response);
  }

  const data = userInfoResponseSchema.parse(await response.json());
  const id = data.sub ?? data.id ?? data.user_id ?? data.account_id;
  if (!id) {
    throw new Error("No user id in Base44 userinfo response");
  }

  return {
    id,
    username:
      data.preferred_username ??
      data.username ??
      data.name ??
      data.email ??
      null,
    email: data.email ?? null,
  };
}
