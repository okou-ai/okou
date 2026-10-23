import * as z from "zod";

import { throwOAuthError } from "../../oauth/error";
import type { OAuthRefreshResult } from "../../oauth/types";
import type {
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthIncompleteResult,
  OAuthDeviceAuthStartResult,
} from "../../provider-flow-types";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";

const SLOCK_API_BASE_URL = "https://api.slock.ai";
const SLOCK_DEVICE_AUTH_URL = `${SLOCK_API_BASE_URL}/api/auth/device/authorize`;
const SLOCK_DEVICE_TOKEN_URL = `${SLOCK_API_BASE_URL}/api/auth/device/token`;
const SLOCK_REFRESH_TOKEN_URL = `${SLOCK_API_BASE_URL}/api/auth/refresh`;
const DEFAULT_DEVICE_AUTH_EXPIRES_IN_SECONDS = 600;
const POST_TOKEN_LOOKUP_FAILED_DESCRIPTION =
  "Unable to load Slock account metadata after authorization.";
const SLOCK_SERVER_ID_SECRET_NAME = "SLOCK_SERVER_ID";

const deviceAuthResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string().optional(),
  expiresIn: z.number().optional(),
  interval: z.number().optional(),
});

const tokenResponseSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().nullable().optional(),
  expiresIn: z.number().optional(),
  userId: z.string().optional(),
});

const jwtPayloadSchema = z.object({
  exp: z.number(),
});

const tokenErrorResponseSchema = z
  .object({
    code: z.string().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    errorDescription: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

const userInfoResponseSchema = z
  .object({
    id: z.string().optional(),
    userId: z.string().optional(),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .passthrough();

const serverSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    isDefault: z.boolean().optional(),
    isCurrent: z.boolean().optional(),
    default: z.boolean().optional(),
    current: z.boolean().optional(),
  })
  .passthrough();

type SlockServer = z.infer<typeof serverSchema>;
type SlockServerCollection = {
  readonly servers: readonly SlockServer[];
  readonly preferredServerId: string | undefined;
};
const serverArraySchema = z.array(serverSchema);
const serversObjectResponseSchema = z
  .object({
    servers: serverArraySchema,
    currentServerId: z.string().optional(),
    defaultServerId: z.string().optional(),
    selectedServerId: z.string().optional(),
  })
  .passthrough();
const nestedServersObjectResponseSchema = z
  .object({ data: serversObjectResponseSchema })
  .passthrough();

async function safeJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => {
    return null;
  });
}

function absoluteVerificationUri(uri: string): string {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return uri;
  }
  const prefix = uri.startsWith("/") ? "" : "/";
  return `${SLOCK_API_BASE_URL}${prefix}${uri}`;
}

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

function deviceCompletionErrorResult(args: {
  readonly error: string;
  readonly errorDescription: string | undefined;
}): OAuthDeviceAuthIncompleteResult {
  return {
    status: "error",
    error: args.error,
    errorDescription: args.errorDescription,
  };
}

function pollErrorFromPayload(payload: unknown): {
  readonly error: string;
  readonly errorDescription: string | undefined;
} | null {
  const parsed = tokenErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const error = parsed.data.code ?? parsed.data.error;
  if (!error) {
    return null;
  }
  return {
    error,
    errorDescription:
      parsed.data.errorDescription ??
      parsed.data.error_description ??
      parsed.data.message,
  };
}

function requireAccessToken(
  data: z.infer<typeof tokenResponseSchema>,
  operation: string,
): string {
  if (!data.accessToken) {
    throw new Error(`No access token in Slock ${operation} response`);
  }
  return data.accessToken;
}

function accessTokenExpiresIn(accessToken: string): number | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) {
      return undefined;
    }
    const parsed = jwtPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
    );
    if (!parsed.success) {
      return undefined;
    }
    return Math.floor(parsed.data.exp - Date.now() / 1000);
  } catch {
    return undefined;
  }
}

function serversFromResponse(data: unknown): SlockServerCollection {
  const arrayParse = serverArraySchema.safeParse(data);
  if (arrayParse.success) {
    return { servers: arrayParse.data, preferredServerId: undefined };
  }
  const objectParse = serversObjectResponseSchema.safeParse(data);
  if (objectParse.success) {
    return {
      servers: objectParse.data.servers,
      preferredServerId:
        objectParse.data.currentServerId ??
        objectParse.data.defaultServerId ??
        objectParse.data.selectedServerId,
    };
  }
  const nested = nestedServersObjectResponseSchema.parse(data).data;
  return {
    servers: nested.servers,
    preferredServerId:
      nested.currentServerId ??
      nested.defaultServerId ??
      nested.selectedServerId,
  };
}

function selectSlockServer(
  collection: SlockServerCollection,
): SlockServer | null {
  if (collection.preferredServerId) {
    const preferredServer = collection.servers.find((server) => {
      return server.id === collection.preferredServerId;
    });
    if (preferredServer) {
      return preferredServer;
    }
  }

  return (
    collection.servers.find((server) => {
      return (
        server.isDefault === true ||
        server.isCurrent === true ||
        server.default === true ||
        server.current === true
      );
    }) ??
    collection.servers[0] ??
    null
  );
}

async function fetchSlockUserInfo(
  accessToken: string,
  fallbackUserId: string | undefined,
): Promise<ConnectorAuthProviderGrantUserInfo> {
  const response = await fetch(`${SLOCK_API_BASE_URL}/api/auth/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    await throwOAuthError("Slock", "userinfo", response);
  }

  const data = userInfoResponseSchema.parse(await response.json());
  const id = data.id ?? data.userId ?? fallbackUserId;
  if (!id) {
    throw new Error("No user id in Slock userinfo response");
  }

  return {
    id,
    username: data.displayName ?? data.name ?? data.email ?? null,
    email: data.email ?? null,
  };
}

async function fetchSlockServerId(
  accessToken: string,
): Promise<
  | { readonly ok: true; readonly serverId: string }
  | OAuthDeviceAuthIncompleteResult
> {
  const response = await fetch(`${SLOCK_API_BASE_URL}/api/servers`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    await throwOAuthError("Slock", "server list", response);
  }

  const server = selectSlockServer(serversFromResponse(await response.json()));
  if (!server) {
    return {
      status: "error",
      error: "no_servers",
      errorDescription: "No Slock servers found for this account",
    };
  }
  return { ok: true, serverId: server.id };
}

export async function startSlockDeviceAuth(): Promise<OAuthDeviceAuthStartResult> {
  const response = await fetch(SLOCK_DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    await throwOAuthError("Slock", "device authorization start", response);
  }

  const data = deviceAuthResponseSchema.parse(await response.json());
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: absoluteVerificationUri(data.verificationUri),
    verificationUriComplete: data.verificationUriComplete
      ? absoluteVerificationUri(data.verificationUriComplete)
      : undefined,
    expiresIn: data.expiresIn ?? DEFAULT_DEVICE_AUTH_EXPIRES_IN_SECONDS,
    interval: data.interval,
  };
}

export async function pollSlockDeviceAuth(args: {
  readonly deviceCode: string;
}): Promise<OAuthDeviceAuthPollResult<"slock", "oauth">> {
  const response = await fetch(SLOCK_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ deviceCode: args.deviceCode }),
  });

  if (!response.ok) {
    const diagnosticResponse = response.clone();
    const pollError = pollErrorFromPayload(await safeJson(response));
    if (!pollError) {
      return await throwOAuthError(
        "Slock",
        "device authorization poll",
        diagnosticResponse,
      );
    }
    return devicePollErrorResult(pollError);
  }

  const data = tokenResponseSchema.safeParse(await safeJson(response));
  if (!data.success) {
    return deviceCompletionErrorResult({
      error: "token_response_invalid",
      errorDescription: data.error.message,
    });
  }
  const accessToken = data.data.accessToken;
  const refreshToken = data.data.refreshToken;
  if (!accessToken || !refreshToken) {
    return deviceCompletionErrorResult({
      error: "token_response_invalid",
      errorDescription:
        "Server's token response was missing accessToken / refreshToken.",
    });
  }

  let serverIdResult:
    | { readonly ok: true; readonly serverId: string }
    | OAuthDeviceAuthIncompleteResult;
  try {
    serverIdResult = await fetchSlockServerId(accessToken);
  } catch {
    return deviceCompletionErrorResult({
      error: "post_token_lookup_failed",
      errorDescription: POST_TOKEN_LOOKUP_FAILED_DESCRIPTION,
    });
  }
  if (!("ok" in serverIdResult)) {
    return serverIdResult;
  }
  let userInfo: ConnectorAuthProviderGrantUserInfo;
  try {
    userInfo = await fetchSlockUserInfo(accessToken, data.data.userId);
  } catch {
    return deviceCompletionErrorResult({
      error: "post_token_lookup_failed",
      errorDescription: POST_TOKEN_LOOKUP_FAILED_DESCRIPTION,
    });
  }

  return {
    status: "complete",
    token: {
      outputs: {
        accessToken,
        refreshToken,
      },
      expiresIn: accessTokenExpiresIn(accessToken),
      scopes: [],
      userInfo,
      extraConnectorSecrets: {
        [SLOCK_SERVER_ID_SECRET_NAME]: serverIdResult.serverId,
      },
    },
  };
}

export async function refreshSlockToken(
  args: {
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<OAuthRefreshResult> {
  const response = await fetch(SLOCK_REFRESH_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refreshToken: args.refreshToken }),
  });

  if (!response.ok) {
    await throwOAuthError("Slock", "refresh", response);
  }

  const data = tokenResponseSchema.parse(await response.json());
  const accessToken = requireAccessToken(data, "refresh");
  return {
    accessToken,
    refreshToken: data.refreshToken ?? null,
    expiresIn: accessTokenExpiresIn(accessToken),
    scopes: null,
  };
}
