import { buildDiscoveryUrls } from "@modelcontextprotocol/client";
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { safeJsonParse, safeSync, settle } from "../utils";
import { mcpOAuthSafeFetch } from "./mcp-oauth-safe-fetch.service";

const ID_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS = 60;

const oidcDiscoveryIdentitySchema = z
  .object({
    issuer: z.url({ protocol: /^https$/u }),
    authorization_endpoint: z.url({ protocol: /^https$/u }),
    token_endpoint: z.url({ protocol: /^https$/u }),
    jwks_uri: z.url({ protocol: /^https$/u }),
    userinfo_endpoint: z.url({ protocol: /^https$/u }).optional(),
    id_token_signing_alg_values_supported: z.array(z.string()).min(1),
  })
  .passthrough();

const jwksSchema = z
  .object({
    keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  })
  .passthrough();

const identityClaimSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    return value.trim().length > 0;
  });

const identityClaimsSchema = z
  .object({
    sub: identityClaimSchema,
    azp: z.string().min(1).optional(),
    exp: z.number().int(),
    iat: z.number().int(),
  })
  .passthrough();

const userInfoClaimsSchema = z
  .object({
    sub: identityClaimSchema,
  })
  .passthrough();

const untrustedIssuerClaimSchema = z
  .object({
    iss: z.url({ protocol: /^https$/u }),
  })
  .passthrough();

interface McpAutomaticOAuthIdentityMetadata {
  readonly jwksUri: string;
  readonly userInfoEndpoint: string | null;
  readonly idTokenSigningAlgorithms: readonly string[];
}

interface McpAutomaticOAuthIdentityContext {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
}

export interface McpAutomaticOAuthUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

function supportedIdentitySigningAlgorithm(algorithm: string): boolean {
  return /^(?:RS|PS|ES)\d+$/u.test(algorithm) || algorithm === "EdDSA";
}

function optionalOidcIdentityMetadata(
  metadata: z.infer<typeof oidcDiscoveryIdentitySchema>,
): McpAutomaticOAuthIdentityMetadata | undefined {
  const idTokenSigningAlgorithms = [
    ...new Set(
      metadata.id_token_signing_alg_values_supported.filter(
        supportedIdentitySigningAlgorithm,
      ),
    ),
  ];
  if (idTokenSigningAlgorithms.length === 0) {
    return undefined;
  }
  return {
    jwksUri: metadata.jwks_uri,
    userInfoEndpoint: metadata.userinfo_endpoint ?? null,
    idTokenSigningAlgorithms,
  };
}

async function discoverOptionalOidcIdentityMetadata(
  context: McpAutomaticOAuthIdentityContext,
  signal: AbortSignal,
): Promise<McpAutomaticOAuthIdentityMetadata | undefined> {
  const oidcDiscoveryUrls = buildDiscoveryUrls(context.issuer).filter(
    (candidate) => {
      return candidate.type === "oidc";
    },
  );
  for (const candidate of oidcDiscoveryUrls) {
    const fetched = await settle(
      mcpOAuthSafeFetch(candidate.url, {
        headers: { accept: "application/json" },
        signal,
      }),
      signal,
    );
    if (!fetched.ok) {
      continue;
    }
    const response = fetched.value;
    if (!response.ok) {
      continue;
    }
    const metadata = oidcDiscoveryIdentitySchema.safeParse(
      safeJsonParse(await response.text()),
    );
    if (
      !metadata.success ||
      metadata.data.issuer !== context.issuer ||
      metadata.data.authorization_endpoint !== context.authorizationEndpoint ||
      metadata.data.token_endpoint !== context.tokenEndpoint
    ) {
      continue;
    }
    return optionalOidcIdentityMetadata(metadata.data);
  }
  return undefined;
}

interface OptionalIdentityClaims {
  readonly preferredUsername: string | null;
  readonly name: string | null;
  readonly email: string | null;
}

function optionalIdentityClaim(value: unknown): string | null {
  const parsed = identityClaimSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function optionalIdentityClaims(
  claims: Readonly<Record<string, unknown>>,
): OptionalIdentityClaims {
  return {
    preferredUsername: optionalIdentityClaim(claims.preferred_username),
    name: optionalIdentityClaim(claims.name),
    email: optionalIdentityClaim(claims.email),
  };
}

function validIdentityTimeClaims(claims: {
  readonly exp: number;
  readonly iat: number;
}): boolean {
  const nowSeconds = Math.floor(nowDate().getTime() / 1000);
  return (
    claims.exp > claims.iat &&
    claims.iat <= nowSeconds + ID_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS
  );
}

function validateAuthorizedParty(
  payload: JWTPayload,
  clientId: string,
): boolean {
  const audience = payload.aud;
  if (Array.isArray(audience) && audience.length > 1) {
    return payload.azp === clientId;
  }
  return payload.azp === undefined || payload.azp === clientId;
}

async function fetchOptionalIdentityJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await mcpOAuthSafeFetch(url, { ...init, signal });
  if (!response.ok) {
    throw new Error("MCP OAuth identity endpoint returned an error");
  }
  return safeJsonParse(await response.text());
}

async function optionalUserInfoClaims(
  metadata: McpAutomaticOAuthIdentityMetadata,
  accessToken: string,
  subject: string,
  signal: AbortSignal,
): Promise<z.infer<typeof userInfoClaimsSchema> | null> {
  const userInfoEndpoint = metadata.userInfoEndpoint;
  if (!userInfoEndpoint) {
    return null;
  }
  const result = await settle(
    (async () => {
      const parsed = userInfoClaimsSchema.safeParse(
        await fetchOptionalIdentityJson(
          userInfoEndpoint,
          {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
            },
          },
          signal,
        ),
      );
      return parsed.success && parsed.data.sub === subject ? parsed.data : null;
    })(),
    signal,
  );
  if (!result.ok) {
    signal.throwIfAborted();
    return null;
  }
  return result.value;
}

export async function discoverMcpAutomaticOAuthUserInfo(
  args: {
    readonly context: McpAutomaticOAuthIdentityContext;
    readonly accessToken: string;
    readonly idToken: string | undefined;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthUserInfo | null> {
  const idToken = args.idToken;
  if (!idToken) {
    return null;
  }
  const metadataResult = await settle(
    discoverOptionalOidcIdentityMetadata(args.context, signal),
    signal,
  );
  signal.throwIfAborted();
  const metadata = metadataResult.ok ? metadataResult.value : undefined;
  if (!metadata) {
    return null;
  }
  const result = await settle(
    (async () => {
      const jwks = jwksSchema.parse(
        await fetchOptionalIdentityJson(metadata.jwksUri, {}, signal),
      );
      const verified = await jwtVerify(
        idToken,
        createLocalJWKSet(jwks as JSONWebKeySet),
        {
          issuer: args.context.issuer,
          audience: args.context.clientId,
          algorithms: [...metadata.idTokenSigningAlgorithms],
          currentDate: nowDate(),
        },
      );
      if (!validateAuthorizedParty(verified.payload, args.context.clientId)) {
        return null;
      }
      const claims = identityClaimsSchema.parse(verified.payload);
      if (!validIdentityTimeClaims(claims)) {
        return null;
      }
      const userInfo = await optionalUserInfoClaims(
        metadata,
        args.accessToken,
        claims.sub,
        signal,
      );
      const tokenLabels = optionalIdentityClaims(claims);
      const userInfoLabels = userInfo ? optionalIdentityClaims(userInfo) : null;
      const username =
        userInfoLabels?.preferredUsername ??
        userInfoLabels?.name ??
        userInfoLabels?.email ??
        tokenLabels.preferredUsername ??
        tokenLabels.name ??
        tokenLabels.email ??
        null;
      return {
        id: claims.sub,
        username,
        email: userInfoLabels?.email ?? tokenLabels.email,
      };
    })(),
    signal,
  );
  if (!result.ok) {
    signal.throwIfAborted();
    return null;
  }
  return result.value;
}

export async function discoverStaticCustomOAuthUserInfo(
  args: {
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly accessToken: string;
    readonly idToken: string | null;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthUserInfo | null> {
  const idToken = args.idToken;
  if (!idToken) {
    return null;
  }
  const issuerResult = safeSync(() => {
    return untrustedIssuerClaimSchema.parse(decodeJwt(idToken)).iss;
  });
  if ("error" in issuerResult) {
    return null;
  }
  // The decoded issuer is only a discovery hint. The shared verifier accepts
  // it only when safe-fetched metadata rebinds it to both configured OAuth
  // endpoints and the token verifies against that issuer.
  return await discoverMcpAutomaticOAuthUserInfo(
    {
      context: {
        issuer: issuerResult.ok,
        authorizationEndpoint: args.authorizationEndpoint,
        tokenEndpoint: args.tokenEndpoint,
        clientId: args.clientId,
      },
      accessToken: args.accessToken,
      idToken,
    },
    signal,
  );
}
