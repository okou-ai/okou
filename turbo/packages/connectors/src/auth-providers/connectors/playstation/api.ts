import { Buffer } from "node:buffer";

import { number, object, string, type infer as zInfer } from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@okouai/connectors/connector-config";
import type { ConnectorAuthProviderGrantUserInfo } from "../../grant-result";
import { OAuthProviderHttpError, throwOAuthError } from "../../oauth/error";

export const PLAYSTATION_AUTH_BASE_URL =
  "https://ca.account.sony.com/api/authz/v3/oauth";
export const PLAYSTATION_NPSSO_URL =
  "https://ca.account.sony.com/api/v1/ssocookie";
export const PLAYSTATION_PROFILE_USERS_URL =
  "https://m.np.playstation.com/api/userProfile/v1/internal/users";
export const PLAYSTATION_REDIRECT_URI =
  "com.scee.psxandroid.scecompcall://redirect";
const PLAYSTATION_CLIENT_SECRET = "ucPjka5tntB2KqsP";

interface PlaystationAuthToken {
  readonly accessToken: string;
  readonly expiresIn?: number;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresIn?: number;
  readonly scope: string | null;
  readonly tokenType: string;
}

interface PlaystationProfile {
  readonly accountId?: string;
  readonly onlineId?: string;
}

interface PlaystationIdentity {
  readonly accountId: string;
  readonly onlineId: string | null;
}

const playstationAuthTokenSchema = object({
  access_token: string().min(1),
  expires_in: number().optional(),
  id_token: string().min(1),
  refresh_token: string().min(1),
  refresh_token_expires_in: number().optional(),
  scope: string().optional(),
  token_type: string().optional(),
});

const playstationRefreshTokenSchema = playstationAuthTokenSchema.extend({
  refresh_token: string().min(1).optional(),
});

const playstationProfileSchema = object({
  accountId: string().min(1).optional(),
  onlineId: string().min(1).optional(),
}).passthrough();

const playstationIdTokenClaimsSchema = object({
  sub: string().min(1).optional(),
  account_id: string().min(1).optional(),
  online_id: string().min(1).optional(),
}).passthrough();

const playstationNpssoJsonSchema = object({
  npsso: string().min(1),
}).passthrough();

function invalidNpssoError(): OAuthProviderHttpError {
  return new OAuthProviderHttpError(
    "PlayStation NPSSO exchange failed: invalid NPSSO token",
    400,
    "invalid_grant",
  );
}

function normalizePlaystationNpsso(input: string): string {
  const trimmed = input.trim();
  let value = trimmed;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const npssoJson = playstationNpssoJsonSchema.safeParse(parsed);
      if (!npssoJson.success) {
        throw invalidNpssoError();
      }
      value = npssoJson.data.npsso.trim();
    } catch {
      throw invalidNpssoError();
    }
  }

  if (!value || hasInvalidNpssoCookieCharacter(value)) {
    throw invalidNpssoError();
  }
  return value;
}

function hasInvalidNpssoCookieCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x21 ||
      codePoint > 0x7e ||
      codePoint === 0x22 ||
      codePoint === 0x2c ||
      codePoint === 0x3b ||
      codePoint === 0x5c
    ) {
      return true;
    }
  }
  return false;
}

function playstationClientBasicAuthHeader(clientId: string): string {
  return `Basic ${Buffer.from(
    `${clientId}:${PLAYSTATION_CLIENT_SECRET}`,
  ).toString("base64")}`;
}

export function buildPlaystationNpssoUrl(): string {
  return PLAYSTATION_NPSSO_URL;
}

function buildPlaystationAuthorizationUrl(args: {
  readonly clientId: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
}): string {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: args.clientId,
    redirect_uri: PLAYSTATION_REDIRECT_URI,
    response_type: "code",
    scope: args.grant.scopes.join(" "),
  });

  return `${PLAYSTATION_AUTH_BASE_URL}/authorize?${params.toString()}`;
}

function authorizationCodeFromRedirect(location: string | null): string | null {
  if (!location) {
    return null;
  }

  try {
    return new URL(location).searchParams.get("code");
  } catch {
    const query = location.includes("redirect/")
      ? location.split("redirect/")[1]
      : location;
    const params = new URLSearchParams(query);
    return params.get("code");
  }
}

export async function exchangePlaystationNpssoForAccessCode(
  args: {
    readonly npsso: string;
    readonly clientId: string;
    readonly grant: ConnectorExternalCodeGrantConfig;
  },
  signal: AbortSignal,
): Promise<string> {
  const npsso = normalizePlaystationNpsso(args.npsso);
  const response = await fetch(
    buildPlaystationAuthorizationUrl({
      clientId: args.clientId,
      grant: args.grant,
    }),
    {
      headers: {
        Cookie: `npsso=${npsso}`,
      },
      redirect: "manual",
      signal,
    },
  );
  const code = authorizationCodeFromRedirect(response.headers.get("location"));
  if (code) {
    return code;
  }
  throw new OAuthProviderHttpError(
    `PlayStation NPSSO exchange failed: ${response.status}`,
    response.status,
    "invalid_grant",
  );
}

function playstationTokenFromResponse(
  raw: zInfer<typeof playstationAuthTokenSchema>,
): PlaystationAuthToken {
  return {
    accessToken: raw.access_token,
    ...(raw.expires_in === undefined ? {} : { expiresIn: raw.expires_in }),
    idToken: raw.id_token,
    refreshToken: raw.refresh_token,
    ...(raw.refresh_token_expires_in === undefined
      ? {}
      : { refreshTokenExpiresIn: raw.refresh_token_expires_in }),
    scope: raw.scope ?? null,
    tokenType: raw.token_type ?? "bearer",
  };
}

async function tokenResponseJson(
  response: Response,
  operation: "exchange" | "refresh",
): Promise<unknown> {
  if (!response.ok) {
    await throwOAuthError("PlayStation", operation, response);
  }
  return await response.json();
}

export async function exchangePlaystationAccessCodeForAuthTokens(
  args: {
    readonly accessCode: string;
    readonly clientId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationAuthToken> {
  const response = await fetch(`${PLAYSTATION_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: playstationClientBasicAuthHeader(args.clientId),
    },
    body: new URLSearchParams({
      code: args.accessCode,
      redirect_uri: PLAYSTATION_REDIRECT_URI,
      grant_type: "authorization_code",
      token_format: "jwt",
    }),
    signal,
  });

  return playstationTokenFromResponse(
    playstationAuthTokenSchema.parse(
      await tokenResponseJson(response, "exchange"),
    ),
  );
}

export async function refreshPlaystationAuthTokens(
  args: {
    readonly refreshToken: string;
    readonly clientId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationAuthToken> {
  const response = await fetch(`${PLAYSTATION_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: playstationClientBasicAuthHeader(args.clientId),
    },
    body: new URLSearchParams({
      refresh_token: args.refreshToken,
      grant_type: "refresh_token",
      token_format: "jwt",
      scope: "psn:mobile.v2.core psn:clientapp",
    }),
    signal,
  });

  const raw = playstationRefreshTokenSchema.parse(
    await tokenResponseJson(response, "refresh"),
  );
  return playstationTokenFromResponse({
    ...raw,
    refresh_token: raw.refresh_token ?? args.refreshToken,
  });
}

function parsePlaystationIdToken(idToken: string): PlaystationIdentity {
  const [, payload] = idToken.split(".");
  if (!payload) {
    throw new Error("PlayStation ID token is missing a payload");
  }
  const rawClaims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const claims = playstationIdTokenClaimsSchema.parse(rawClaims);
  const accountId = claims.account_id ?? claims.sub;
  if (!accountId) {
    throw new Error("PlayStation ID token is missing an account id");
  }
  return {
    accountId,
    onlineId: claims.online_id ?? null,
  };
}

async function fetchPlaystationProfile(
  args: {
    readonly accessToken: string;
    readonly accountId: string;
  },
  signal: AbortSignal,
): Promise<PlaystationProfile> {
  const response = await fetch(
    `${PLAYSTATION_PROFILE_USERS_URL}/${encodeURIComponent(args.accountId)}/profiles`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
      signal,
    },
  );
  if (!response.ok) {
    await throwOAuthError("PlayStation", "profile", response);
  }
  return playstationProfileSchema.parse(await response.json());
}

export async function fetchPlaystationIdentity(
  args: {
    readonly accessToken: string;
    readonly idToken: string;
  },
  signal: AbortSignal,
): Promise<PlaystationIdentity> {
  const tokenIdentity = parsePlaystationIdToken(args.idToken);
  const profile = await fetchPlaystationProfile(
    {
      accessToken: args.accessToken,
      accountId: tokenIdentity.accountId,
    },
    signal,
  );
  return {
    accountId: profile.accountId ?? tokenIdentity.accountId,
    onlineId: profile.onlineId ?? tokenIdentity.onlineId,
  };
}

export function playstationUserInfo(
  identity: PlaystationIdentity,
): ConnectorAuthProviderGrantUserInfo {
  return {
    id: identity.accountId,
    username: identity.onlineId,
    email: null,
  };
}
