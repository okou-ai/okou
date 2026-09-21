import { buildDiscoveryUrls } from "@modelcontextprotocol/client";
import {
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";

import { safeJsonParse, settle } from "../utils";
import {
  mcpOAuthSafeFetch,
  validateMcpOAuthPublicUrl,
} from "./mcp-oauth-safe-fetch.service";

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
    preferred_username: identityClaimSchema.optional(),
    name: identityClaimSchema.optional(),
    email: identityClaimSchema.optional(),
    azp: z.string().min(1).optional(),
    exp: z.number().int(),
    iat: z.number().int(),
  })
  .passthrough();

const userInfoClaimsSchema = z
  .object({
    sub: identityClaimSchema,
    preferred_username: identityClaimSchema.optional(),
    name: identityClaimSchema.optional(),
    email: identityClaimSchema.optional(),
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

async function optionalOidcIdentityMetadata(
  metadata: z.infer<typeof oidcDiscoveryIdentitySchema>,
  signal: AbortSignal,
): Promise<McpAutomaticOAuthIdentityMetadata | undefined> {
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
  const jwksUri = await settle(
    validateMcpOAuthPublicUrl(metadata.jwks_uri, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!jwksUri.ok) {
    return undefined;
  }
  const userInfoEndpoint = metadata.userinfo_endpoint
    ? await settle(
        validateMcpOAuthPublicUrl(metadata.userinfo_endpoint, signal),
        signal,
      )
    : null;
  signal.throwIfAborted();
  return {
    jwksUri: jwksUri.value,
    userInfoEndpoint:
      userInfoEndpoint === null || !userInfoEndpoint.ok
        ? null
        : userInfoEndpoint.value,
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
    const response = await mcpOAuthSafeFetch(candidate.url, {
      headers: { accept: "application/json" },
      signal,
    });
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
    return await optionalOidcIdentityMetadata(metadata.data, signal);
  }
  return undefined;
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
        },
      );
      if (!validateAuthorizedParty(verified.payload, args.context.clientId)) {
        return null;
      }
      const claims = identityClaimsSchema.parse(verified.payload);
      const userInfo = await optionalUserInfoClaims(
        metadata,
        args.accessToken,
        claims.sub,
        signal,
      );
      const username =
        userInfo?.preferred_username ??
        userInfo?.name ??
        userInfo?.email ??
        claims.preferred_username ??
        claims.name ??
        claims.email ??
        null;
      return {
        id: claims.sub,
        username,
        email: userInfo?.email ?? claims.email ?? null,
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
  const issuerResult = await settle(
    (async () => {
      return untrustedIssuerClaimSchema.parse(decodeJwt(idToken)).iss;
    })(),
    signal,
  );
  signal.throwIfAborted();
  if (!issuerResult.ok) {
    return null;
  }
  const publicIssuer = await settle(
    validateMcpOAuthPublicUrl(issuerResult.value, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!publicIssuer.ok) {
    return null;
  }
  // The decoded issuer is only a discovery hint. The shared verifier accepts
  // it only when signed metadata rebinds it to both configured OAuth endpoints.
  return await discoverMcpAutomaticOAuthUserInfo(
    {
      context: {
        issuer: issuerResult.value,
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
