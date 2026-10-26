import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { array, literal, number, object, string, union } from "zod";

import type { ConnectorExternalCodeGrantConfig } from "@okouai/connectors/connector-config";
import type { ConnectorAuthProviderGrantUserInfo } from "../grant-result";
import { OAuthProviderHttpError, throwOAuthError } from "../oauth/error";

export const NINTENDO_ACCOUNT_AUTHORIZATION_URL =
  "https://accounts.nintendo.com/connect/1.0.0/authorize";
export const NINTENDO_ACCOUNT_SESSION_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
export const NINTENDO_ACCOUNT_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/token";
export const NINTENDO_ACCOUNT_PROFILE_URL =
  "https://api.accounts.nintendo.com/2.0.0/users/me";

const NINTENDO_SESSION_TOKEN_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token";

export interface NintendoAccountProviderState {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface NintendoAccountSessionToken {
  readonly sessionToken: string;
}

export interface NintendoAccountToken {
  readonly accessToken: string;
  readonly expiresIn?: number;
  readonly idToken: string;
  readonly scopes: readonly string[] | null;
  readonly tokenType: string;
}

interface NintendoAccountIdentity {
  readonly accountId: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface NintendoAccountProfile {
  readonly country: string;
  readonly language: string;
  readonly locale: string;
}

const nintendoAccountProviderStateSchema = object({
  version: literal(1),
  state: string().min(1).max(128),
  codeVerifier: string().min(43).max(128),
});

const nintendoAccountSessionTokenSchema = object({
  session_token: string().min(1),
}).passthrough();

const nintendoAccountTokenSchema = object({
  access_token: string().min(1),
  expires_in: number().optional(),
  id_token: string().min(1),
  scope: union([string(), array(string())]).optional(),
  token_type: string().optional(),
}).passthrough();

const nintendoAccountIdTokenClaimsSchema = object({
  sub: string().min(1).optional(),
  email: string().min(1).optional(),
  name: string().min(1).optional(),
  preferred_username: string().min(1).optional(),
}).passthrough();

const nintendoAccountProfileSchema = object({
  country: string().min(1),
  language: string().min(1),
}).passthrough();

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function createNintendoAccountProviderState(): NintendoAccountProviderState {
  return {
    version: 1,
    state: base64UrlRandom(36),
    codeVerifier: base64UrlRandom(32),
  };
}

export function parseNintendoAccountProviderState(
  providerState: string,
): NintendoAccountProviderState {
  const parsed: unknown = JSON.parse(providerState);
  return nintendoAccountProviderStateSchema.parse(parsed);
}

export function buildNintendoAccountAuthorizationUrl(args: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly grant: ConnectorExternalCodeGrantConfig;
  readonly providerState: NintendoAccountProviderState;
}): string {
  const params = new URLSearchParams({
    state: args.providerState.state,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.grant.scopes.join(" "),
    response_type: "session_token_code",
    session_token_code_challenge: sha256Base64Url(
      args.providerState.codeVerifier,
    ),
    session_token_code_challenge_method: "S256",
    theme: "login_form",
  });

  return `${NINTENDO_ACCOUNT_AUTHORIZATION_URL}?${params.toString()}`;
}

function invalidNintendoExternalCodeError(
  providerLabel: string,
  message: string,
): OAuthProviderHttpError {
  return new OAuthProviderHttpError(
    `${providerLabel} ${message}`,
    400,
    "invalid_grant",
  );
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseParamsFromInput(input: string): URLSearchParams | null {
  if (input.startsWith("#")) {
    return new URLSearchParams(input.slice(1));
  }
  if (input.startsWith("?")) {
    return new URLSearchParams(input.slice(1));
  }
  if (input.includes("://")) {
    try {
      const parsed = new URL(input);
      const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
      if (fragmentParams.toString().length > 0) {
        return fragmentParams;
      }
      return parsed.searchParams;
    } catch {
      return new URLSearchParams();
    }
  }
  if (input.includes("session_token_code=")) {
    try {
      const parsed = new URL(input);
      const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
      if (fragmentParams.has("session_token_code")) {
        return fragmentParams;
      }
      return parsed.searchParams;
    } catch {
      return new URLSearchParams(input.replace(/^#/u, "").replace(/^\?/u, ""));
    }
  }
  return null;
}

export function parseNintendoAccountSessionTokenCode(args: {
  readonly code: string;
  readonly expectedState: string;
  readonly providerLabel: string;
}): string {
  const trimmed = args.code.trim();
  if (!trimmed || hasAsciiControl(trimmed)) {
    throw invalidNintendoExternalCodeError(
      args.providerLabel,
      "authorization code is empty or invalid",
    );
  }

  const params = parseParamsFromInput(trimmed);
  if (!params) {
    return trimmed;
  }

  const state = params.get("state");
  if (state !== null && state !== args.expectedState) {
    throw invalidNintendoExternalCodeError(
      args.providerLabel,
      "authorization state mismatch",
    );
  }

  const sessionTokenCode = params.get("session_token_code")?.trim();
  if (!sessionTokenCode || hasAsciiControl(sessionTokenCode)) {
    throw invalidNintendoExternalCodeError(
      args.providerLabel,
      "redirect URL is missing session_token_code",
    );
  }
  return sessionTokenCode;
}

export async function exchangeNintendoAccountSessionTokenCode(
  args: {
    readonly clientId: string;
    readonly sessionTokenCode: string;
    readonly codeVerifier: string;
    readonly userAgent: string;
    readonly providerLabel: string;
  },
  signal: AbortSignal,
): Promise<NintendoAccountSessionToken> {
  const response = await fetch(NINTENDO_ACCOUNT_SESSION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": args.userAgent,
      Accept: "application/json",
      "Accept-Language": "en-US",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      session_token_code: args.sessionTokenCode,
      session_token_code_verifier: args.codeVerifier,
    }),
    signal,
  });

  if (!response.ok) {
    await throwOAuthError(args.providerLabel, "session exchange", response);
  }

  const raw = nintendoAccountSessionTokenSchema.parse(await response.json());
  return { sessionToken: raw.session_token };
}

function normalizeScopes(
  scope: string | readonly string[] | undefined,
): readonly string[] | null {
  if (typeof scope !== "string") {
    return scope ?? null;
  }
  return scope.split(/\s+/u).filter((value: string) => {
    return value.length > 0;
  });
}

export async function exchangeNintendoAccountSessionToken(
  args: {
    readonly clientId: string;
    readonly sessionToken: string;
    readonly userAgent: string;
    readonly providerLabel: string;
  },
  signal: AbortSignal,
): Promise<NintendoAccountToken> {
  const response = await fetch(NINTENDO_ACCOUNT_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": args.userAgent,
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      session_token: args.sessionToken,
      grant_type: NINTENDO_SESSION_TOKEN_GRANT_TYPE,
    }),
    signal,
  });

  if (!response.ok) {
    await throwOAuthError(args.providerLabel, "token exchange", response);
  }

  const raw = nintendoAccountTokenSchema.parse(await response.json());
  return {
    accessToken: raw.access_token,
    ...(raw.expires_in === undefined ? {} : { expiresIn: raw.expires_in }),
    idToken: raw.id_token,
    scopes: normalizeScopes(raw.scope),
    tokenType: raw.token_type ?? "Bearer",
  };
}

export async function fetchNintendoAccountProfile(
  args: {
    readonly accessToken: string;
    readonly userAgent: string;
    readonly providerLabel: string;
  },
  signal: AbortSignal,
): Promise<NintendoAccountProfile> {
  const response = await fetch(NINTENDO_ACCOUNT_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "User-Agent": args.userAgent,
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    await throwOAuthError(args.providerLabel, "profile", response);
  }

  const raw = nintendoAccountProfileSchema.parse(await response.json());
  return {
    country: raw.country,
    language: raw.language,
    locale: `${raw.language}-${raw.country}`,
  };
}

function parseNintendoAccountIdentity(
  idToken: string,
  providerLabel: string,
): NintendoAccountIdentity {
  const [, payload] = idToken.split(".");
  if (!payload) {
    throw new Error(`${providerLabel} ID token is missing a payload`);
  }
  const rawClaims: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const claims = nintendoAccountIdTokenClaimsSchema.parse(rawClaims);
  if (!claims.sub) {
    throw new Error(`${providerLabel} ID token is missing a subject`);
  }
  return {
    accountId: claims.sub,
    username: claims.preferred_username ?? claims.name ?? null,
    email: claims.email ?? null,
  };
}

export function nintendoAccountUserInfo(
  idToken: string,
  providerLabel: string,
): ConnectorAuthProviderGrantUserInfo {
  const identity = parseNintendoAccountIdentity(idToken, providerLabel);
  return {
    id: identity.accountId,
    username: identity.username,
    email: identity.email,
  };
}

export function nintendoAccountId(
  idToken: string,
  providerLabel: string,
): string {
  return parseNintendoAccountIdentity(idToken, providerLabel).accountId;
}
