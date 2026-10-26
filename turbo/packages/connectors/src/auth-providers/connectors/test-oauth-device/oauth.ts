import { number, object, string } from "zod";

import type {
  OAuthDeviceAuthIncompleteResult,
  OAuthDeviceAuthStartResult,
} from "../../provider-flow-types";
import type { ConnectorAuthProviderGrantResult } from "../../grant-result";
import { throwOAuthError } from "../../oauth/error";
import { effectiveOAuthScopes } from "../../oauth/scope";
import {
  resolveTestOAuthProviderUrl,
  testOAuthPreviewBypassHeaders,
} from "../test-oauth/oauth";

const TEST_OAUTH_DEVICE_AUTH_URL = "/api/test/oauth-provider/device/code";
const TEST_OAUTH_DEVICE_TOKEN_URL = "/api/test/oauth-provider/token";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const deviceAuthResponseSchema = object({
  device_code: string(),
  user_code: string(),
  verification_uri: string(),
  verification_uri_complete: string().optional(),
  expires_in: number(),
  interval: number().optional(),
});

const tokenResponseSchema = object({
  access_token: string(),
  refresh_token: string().nullable().optional(),
  expires_in: number().optional(),
  token_type: string().optional(),
  scope: string().optional(),
});

const tokenErrorResponseSchema = object({
  error: string(),
  error_description: string().optional(),
});

type TestOAuthDeviceTokenResult = ConnectorAuthProviderGrantResult<{
  readonly accessToken: string;
}>;

type TestOAuthDevicePollResult =
  | OAuthDeviceAuthIncompleteResult
  | {
      readonly status: "complete";
      readonly token: TestOAuthDeviceTokenResult;
    };

function getDeviceAuthUrl(): string {
  return resolveTestOAuthProviderUrl(
    "deviceAuthUrl",
    TEST_OAUTH_DEVICE_AUTH_URL,
  );
}

function getDeviceTokenUrl(): string {
  return resolveTestOAuthProviderUrl("tokenUrl", TEST_OAUTH_DEVICE_TOKEN_URL);
}

export async function startTestOAuthDeviceAuth(args: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly mode?: string;
}): Promise<OAuthDeviceAuthStartResult> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    scope: args.scopes.join(" "),
  });
  if (args.mode !== undefined) {
    body.set("mode", args.mode);
  }

  const response = await fetch(getDeviceAuthUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...testOAuthPreviewBypassHeaders(),
    },
    body,
  });

  if (!response.ok) {
    await throwOAuthError("TestOAuthDevice", "start", response);
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

function devicePollErrorResult(args: {
  readonly error: string;
  readonly errorDescription: string | undefined;
}): OAuthDeviceAuthIncompleteResult | null {
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
  if (args.error === "invalid_request" || args.error === "invalid_grant") {
    return {
      status: "error",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  return null;
}

export async function pollTestOAuthDeviceAuth(args: {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly scopes: readonly string[];
}): Promise<TestOAuthDevicePollResult> {
  const response = await fetch(getDeviceTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...testOAuthPreviewBypassHeaders(),
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
        "TestOAuthDevice",
        "poll",
        diagnosticResponse,
      );
    }
    const errorData = errorParse.data;
    const result = devicePollErrorResult({
      error: errorData.error,
      errorDescription: errorData.error_description,
    });
    if (result) {
      return result;
    }
    await throwOAuthError("TestOAuthDevice", "poll", diagnosticResponse);
  }

  const data = tokenResponseSchema.parse(await response.json());
  return {
    status: "complete",
    token: {
      outputs: {
        accessToken: data.access_token,
      },
      expiresIn: data.expires_in,
      scopes: effectiveOAuthScopes(data.scope, args.scopes, " "),
      userInfo: {
        id: "test-oauth-device-user",
        username: "test-oauth-device-user",
        email: "test-oauth-device@example.com",
      },
    },
  };
}
