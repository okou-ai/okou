import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { accept } from "@okouai/connectors/accept";

import { env, optionalEnv } from "./env";
import { singleton } from "./singleton";
import { now } from "./time";
import { safeJsonParse, safeSync } from "../signals/utils";

const BOT_FRAMEWORK_OPENID_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const CLOCK_SKEW_SECONDS = 5 * 60;
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type SupportedJwtAlgorithm = "RS256" | "RS384" | "RS512";

interface JwtHeader {
  readonly alg: SupportedJwtAlgorithm;
  readonly kid?: string;
  readonly x5t?: string;
}

interface JwtPayload {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly serviceurl?: string;
}

interface OpenIdMetadata {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly algorithms: readonly string[];
}

interface JwkKey {
  readonly kid?: string;
  readonly x5t?: string;
  readonly kty?: string;
  readonly n?: string;
  readonly e?: string;
  readonly x5c?: readonly string[];
  readonly endorsements?: readonly string[];
}

interface JwksDocument {
  readonly keys: readonly JwkKey[];
}

interface CachedKeys {
  readonly expiresAt: number;
  readonly metadata: OpenIdMetadata;
  readonly keys: JwksDocument;
}

class TeamsBotAuthCache {
  keys: CachedKeys | null = null;
}

type TeamsBotAuthResult =
  | { readonly ok: true; readonly claims: JwtPayload }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly message: string;
    };

const teamsBotAuthCaches = singleton(() => {
  return new WeakMap<AbortSignal, TeamsBotAuthCache>();
});

function teamsBotAuthCache(owner: AbortSignal): TeamsBotAuthCache {
  const caches = teamsBotAuthCaches();
  const existing = caches.get(owner);
  if (existing) {
    return existing;
  }
  const cache = new TeamsBotAuthCache();
  caches.set(owner, cache);
  return cache;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

function supportedAlgorithm(
  value: string | null,
): SupportedJwtAlgorithm | null {
  return value === "RS256" || value === "RS384" || value === "RS512"
    ? value
    : null;
}

function parseJwtHeader(value: unknown): JwtHeader | null {
  if (!isRecord(value)) {
    return null;
  }
  const alg = supportedAlgorithm(readString(value, "alg"));
  if (!alg) {
    return null;
  }
  return {
    alg,
    kid: readString(value, "kid") ?? undefined,
    x5t: readString(value, "x5t") ?? undefined,
  };
}

function parseJwtPayload(value: unknown): JwtPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const iss = readString(value, "iss");
  const audValue = value.aud;
  const exp = value.exp;
  if (!iss || typeof exp !== "number") {
    return null;
  }
  if (
    typeof audValue !== "string" &&
    !(
      Array.isArray(audValue) &&
      audValue.every((item) => {
        return typeof item === "string";
      })
    )
  ) {
    return null;
  }
  const nbf = value.nbf;
  return {
    iss,
    aud: audValue,
    exp,
    nbf: typeof nbf === "number" ? nbf : undefined,
    serviceurl: readString(value, "serviceurl") ?? undefined,
  };
}

function decodeJwtJsonSegment(segment: string): unknown {
  const decoded = safeSync(() => {
    return Buffer.from(segment, "base64url").toString("utf8");
  });
  if (!("ok" in decoded)) {
    return undefined;
  }
  return safeJsonParse(decoded.ok);
}

function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return null;
  }
  return parts[1] ?? null;
}

function metadataUrl(): string {
  return (
    optionalEnv("MICROSOFT_TEAMS_BOT_OPENID_METADATA_URL") ??
    BOT_FRAMEWORK_OPENID_METADATA_URL
  );
}

function parseOpenIdMetadata(value: unknown): OpenIdMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  const issuer = readString(value, "issuer");
  const jwksUri = readString(value, "jwks_uri");
  if (!issuer || !jwksUri) {
    return null;
  }
  return {
    issuer,
    jwksUri,
    algorithms: readStringArray(value, "id_token_signing_alg_values_supported"),
  };
}

function parseJwks(value: unknown): JwksDocument | null {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    return null;
  }
  const keys = value.keys.filter((key): key is JwkKey => {
    return isRecord(key);
  });
  return { keys };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await accept(fetch(url), [200]);
  return await response.json();
}

async function loadBotFrameworkKeys(
  cacheOwner: AbortSignal,
): Promise<CachedKeys> {
  const currentTime = now();
  const cache = teamsBotAuthCache(cacheOwner);
  if (cache.keys && cache.keys.expiresAt > currentTime) {
    return cache.keys;
  }

  const metadata = parseOpenIdMetadata(await fetchJson(metadataUrl()));
  if (!metadata) {
    throw new Error("Invalid Teams bot OpenID metadata");
  }
  const keys = parseJwks(await fetchJson(metadata.jwksUri));
  if (!keys) {
    throw new Error("Invalid Teams bot JWKS document");
  }

  cache.keys = {
    metadata,
    keys,
    expiresAt: currentTime + JWKS_CACHE_TTL_MS,
  };
  return cache.keys;
}

function findSigningKey(
  keys: readonly JwkKey[],
  header: JwtHeader,
): JwkKey | null {
  return (
    keys.find((key) => {
      return (
        (!!header.kid && key.kid === header.kid) ||
        (!!header.x5t && key.x5t === header.x5t)
      );
    }) ?? null
  );
}

function publicKeyFromJwk(key: JwkKey): KeyObject | null {
  if (key.x5c?.[0]) {
    const certificate = [
      "-----BEGIN CERTIFICATE-----",
      key.x5c[0],
      "-----END CERTIFICATE-----",
    ].join("\n");
    const parsed = safeSync(() => {
      return createPublicKey(certificate);
    });
    return "ok" in parsed ? parsed.ok : null;
  }

  if (!key.kty || !key.n || !key.e) {
    return null;
  }

  const parsed = safeSync(() => {
    return createPublicKey({
      key: {
        kty: key.kty,
        n: key.n,
        e: key.e,
      },
      format: "jwk",
    });
  });
  return "ok" in parsed ? parsed.ok : null;
}

function verifierAlgorithm(algorithm: SupportedJwtAlgorithm): string {
  if (algorithm === "RS384") {
    return "RSA-SHA384";
  }
  if (algorithm === "RS512") {
    return "RSA-SHA512";
  }
  return "RSA-SHA256";
}

function verifyJwtSignature(args: {
  readonly signingInput: string;
  readonly signature: Buffer;
  readonly key: KeyObject;
  readonly algorithm: SupportedJwtAlgorithm;
}): boolean {
  const verify = createVerify(verifierAlgorithm(args.algorithm));
  verify.update(args.signingInput);
  return verify.verify(args.key, args.signature);
}

function audienceMatches(
  audience: string | readonly string[],
  appId: string,
): boolean {
  return Array.isArray(audience)
    ? audience.includes(appId)
    : audience === appId;
}

function validateClaims(args: {
  readonly claims: JwtPayload;
  readonly metadata: OpenIdMetadata;
  readonly botAppId: string;
  readonly serviceUrl: string;
}): string | null {
  const nowSeconds = Math.floor(now() / 1000);
  if (args.claims.iss !== args.metadata.issuer) {
    return "Invalid Teams bot token issuer";
  }
  if (args.claims.iss !== BOT_FRAMEWORK_ISSUER) {
    return "Invalid Teams bot token issuer";
  }
  if (!audienceMatches(args.claims.aud, args.botAppId)) {
    return "Invalid Teams bot token audience";
  }
  if (args.claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return "Expired Teams bot token";
  }
  if (
    typeof args.claims.nbf === "number" &&
    args.claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds
  ) {
    return "Teams bot token is not active yet";
  }
  if (args.claims.serviceurl !== args.serviceUrl) {
    return "Teams bot token serviceUrl mismatch";
  }
  return null;
}

function keyEndorsesChannel(key: JwkKey, channelId: string | null): boolean {
  if (!channelId || !key.endorsements || key.endorsements.length === 0) {
    return true;
  }
  return key.endorsements.includes(channelId);
}

export async function verifyTeamsBotAuthorization(
  args: {
    readonly authorization: string | undefined;
    readonly serviceUrl: string;
    readonly channelId: string | null;
  },
  cacheOwner: AbortSignal,
): Promise<TeamsBotAuthResult> {
  const botAppId = env("MICROSOFT_TEAMS_BOT_APP_ID");
  if (!botAppId) {
    return {
      ok: false,
      status: 503,
      message: "Microsoft Teams bot integration is not configured",
    };
  }

  const token = extractBearerToken(args.authorization);
  if (!token) {
    return {
      ok: false,
      status: 401,
      message: "Missing Teams bot bearer token",
    };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, message: "Invalid Teams bot token" };
  }

  const header = parseJwtHeader(decodeJwtJsonSegment(parts[0] ?? ""));
  const claims = parseJwtPayload(decodeJwtJsonSegment(parts[1] ?? ""));
  if (!header || !claims) {
    return { ok: false, status: 401, message: "Invalid Teams bot token" };
  }

  const botFrameworkKeys = await loadBotFrameworkKeys(cacheOwner);
  if (!botFrameworkKeys.metadata.algorithms.includes(header.alg)) {
    return {
      ok: false,
      status: 401,
      message: "Unsupported Teams bot token algorithm",
    };
  }

  const signingKey = findSigningKey(botFrameworkKeys.keys.keys, header);
  const publicKey = signingKey ? publicKeyFromJwk(signingKey) : null;
  if (!signingKey || !publicKey) {
    return {
      ok: false,
      status: 401,
      message: "Unknown Teams bot token signing key",
    };
  }

  if (!keyEndorsesChannel(signingKey, args.channelId)) {
    return {
      ok: false,
      status: 403,
      message: "Teams bot token is not endorsed for this channel",
    };
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  const signatureValid = verifyJwtSignature({
    signingInput,
    signature,
    key: publicKey,
    algorithm: header.alg,
  });
  if (!signatureValid) {
    return { ok: false, status: 401, message: "Invalid Teams bot signature" };
  }

  const claimError = validateClaims({
    claims,
    metadata: botFrameworkKeys.metadata,
    botAppId,
    serviceUrl: args.serviceUrl,
  });
  if (claimError) {
    return { ok: false, status: 401, message: claimError };
  }

  return { ok: true, claims };
}
