import {
  Client,
  IssuerMismatchError,
  OAuthError,
  RegistrationRejectedError,
  StreamableHTTPClientTransport,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  selectClientAuthMethod,
  startAuthorization,
  validateAuthorizationResponseIssuer,
  type AuthProvider,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  type CustomConnectorAutomaticOAuthErrorCode,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  McpOAuthUnsafeUrlError,
  mcpOAuthSafeFetch,
  validateMcpOAuthPublicUrl,
} from "./mcp-oauth-safe-fetch.service";

const oauthHttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    return new URL(value).protocol === "https:";
  });

const tokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

const automaticOAuthBindingBaseSchema = z.object({
  connectorAccountId: z.string().uuid(),
  customConnectorId: z.string().uuid(),
  issuer: oauthHttpsUrlSchema,
  resource: oauthHttpsUrlSchema,
  resourceMetadataUrl: oauthHttpsUrlSchema.nullable(),
  tokenEndpoint: oauthHttpsUrlSchema,
  clientId: z.string().min(1),
  tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
});

const dcrRegistrationSchema = z
  .object({
    id: z.string().uuid(),
    customConnectorId: z.string().uuid(),
    issuer: oauthHttpsUrlSchema,
    clientId: z.string().min(1),
    tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
    hasClientSecret: z.boolean(),
    encryptedClientSecret: z.string().min(1).nullable(),
    registeredScopes: z.array(z.string().min(1)),
    redirectUri: oauthHttpsUrlSchema,
    issuedAt: z.date(),
    expiresAt: z.date().nullable(),
  })
  .refine((registration) => {
    return registration.tokenEndpointAuthMethod === "none"
      ? !registration.hasClientSecret &&
          registration.encryptedClientSecret === null
      : registration.hasClientSecret &&
          registration.encryptedClientSecret !== null;
  })
  .refine((registration) => {
    return (
      registration.expiresAt === null ||
      registration.expiresAt > registration.issuedAt
    );
  });

const customConnectorAutomaticOAuthBindingSchema = z.union([
  automaticOAuthBindingBaseSchema.extend({
    registrationMethod: z.literal("cimd"),
    dcrRegistration: z.null(),
    tokenEndpointAuthMethod: z.literal("none"),
  }),
  automaticOAuthBindingBaseSchema
    .extend({
      registrationMethod: z.literal("dcr"),
      dcrRegistration: dcrRegistrationSchema,
    })
    .refine((binding) => {
      return (
        binding.customConnectorId ===
          binding.dcrRegistration.customConnectorId &&
        binding.issuer === binding.dcrRegistration.issuer &&
        binding.clientId === binding.dcrRegistration.clientId &&
        binding.tokenEndpointAuthMethod ===
          binding.dcrRegistration.tokenEndpointAuthMethod
      );
    }),
]);

export type CustomConnectorAutomaticOAuthBinding = z.infer<
  typeof customConnectorAutomaticOAuthBindingSchema
>;

const automaticOAuthBindingPersistenceSchema = z
  .intersection(
    z.object({
      accountAuthMethod: z.literal("oauth"),
      accountStorageVersion: z.number().int().positive(),
      connectorAuthMode: z.literal("automatic"),
      connectorStorageVersion: z.number().int().positive(),
    }),
    customConnectorAutomaticOAuthBindingSchema,
  )
  .refine((row) => {
    return row.accountStorageVersion === row.connectorStorageVersion;
  })
  .transform((row) => {
    return customConnectorAutomaticOAuthBindingSchema.parse(row);
  });

export async function readCustomConnectorAutomaticOAuthBinding(
  db: Db,
  connectorAccountId: string,
): Promise<CustomConnectorAutomaticOAuthBinding | null> {
  const [row] = await db
    .select({
      accountAuthMethod: connectors.authMethod,
      accountStorageVersion: connectors.storageVersion,
      connectorAuthMode: orgCustomConnectors.authMode,
      connectorStorageVersion: orgCustomConnectors.storageVersion,
      connectorAccountId:
        customConnectorAccountOauthBindings.connectorAccountId,
      customConnectorId: customConnectorAccountOauthBindings.customConnectorId,
      issuer: customConnectorAccountOauthBindings.issuer,
      resource: customConnectorAccountOauthBindings.resource,
      resourceMetadataUrl:
        customConnectorAccountOauthBindings.resourceMetadataUrl,
      tokenEndpoint: customConnectorAccountOauthBindings.tokenEndpoint,
      clientId: customConnectorAccountOauthBindings.clientId,
      tokenEndpointAuthMethod:
        customConnectorAccountOauthBindings.tokenEndpointAuthMethod,
      registrationMethod:
        customConnectorAccountOauthBindings.registrationMethod,
      dcrRegistration: {
        id: orgCustomConnectorDcrRegistrations.id,
        customConnectorId: orgCustomConnectorDcrRegistrations.customConnectorId,
        issuer: orgCustomConnectorDcrRegistrations.issuer,
        clientId: orgCustomConnectorDcrRegistrations.clientId,
        tokenEndpointAuthMethod:
          orgCustomConnectorDcrRegistrations.tokenEndpointAuthMethod,
        hasClientSecret: isNotNull(
          orgCustomConnectorDcrRegistrations.encryptedClientSecret,
        ),
        encryptedClientSecret:
          orgCustomConnectorDcrRegistrations.encryptedClientSecret,
        registeredScopes: orgCustomConnectorDcrRegistrations.registeredScopes,
        redirectUri: orgCustomConnectorDcrRegistrations.redirectUri,
        issuedAt: orgCustomConnectorDcrRegistrations.issuedAt,
        expiresAt: orgCustomConnectorDcrRegistrations.expiresAt,
      },
    })
    .from(customConnectorAccountOauthBindings)
    .innerJoin(
      connectors,
      and(
        eq(
          connectors.id,
          customConnectorAccountOauthBindings.connectorAccountId,
        ),
        eq(
          connectors.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(
          orgCustomConnectors.id,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorDcrRegistrations,
      and(
        eq(
          orgCustomConnectorDcrRegistrations.id,
          customConnectorAccountOauthBindings.dcrRegistrationId,
        ),
        eq(
          orgCustomConnectorDcrRegistrations.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .where(
      eq(
        customConnectorAccountOauthBindings.connectorAccountId,
        connectorAccountId,
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const parsed = automaticOAuthBindingPersistenceSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

type AutomaticOAuthIncompatibleReason =
  | "invalid-authentication-response"
  | "invalid-discovery-metadata"
  | "unsupported-authorization"
  | "registration-unavailable"
  | "registration-rejected"
  | "invalid-registration"
  | "registration-conflict";

type AutomaticOAuthFailure =
  | {
      readonly kind: "unsafe";
      readonly reason: "unsafe-url";
    }
  | {
      readonly kind: "temporary";
      readonly reason: "temporary-upstream";
    }
  | {
      readonly kind: "binding-drift";
      readonly reason: "binding-drift";
    }
  | {
      readonly kind: "incompatible";
      readonly reason: AutomaticOAuthIncompatibleReason;
    };

type AutomaticOAuthFailureKind = AutomaticOAuthFailure["kind"];

type AutomaticOAuthRemoteOperation =
  | "MCP authorization challenge"
  | "protected resource discovery"
  | "authorization server discovery"
  | "authorization endpoint validation"
  | "dynamic client registration"
  | "authorization request"
  | "token refresh";

export class CustomConnectorAutomaticOAuthError extends Error {
  readonly kind: AutomaticOAuthFailureKind;
  readonly reason: AutomaticOAuthFailure["reason"];

  constructor(
    failure: AutomaticOAuthFailure,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CustomConnectorAutomaticOAuthError";
    this.kind = failure.kind;
    this.reason = failure.reason;
  }
}

export function customConnectorAutomaticOAuthErrorCode(
  error: CustomConnectorAutomaticOAuthError,
): CustomConnectorAutomaticOAuthErrorCode {
  switch (error.reason) {
    case "invalid-authentication-response": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHENTICATION_RESPONSE_INVALID;
    }
    case "invalid-discovery-metadata": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID;
    }
    case "unsupported-authorization": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED;
    }
    case "registration-unavailable": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_UNAVAILABLE;
    }
    case "registration-rejected": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_REJECTED;
    }
    case "invalid-registration": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_INVALID;
    }
    case "registration-conflict": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_CONFLICT;
    }
    case "unsafe-url": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL;
    }
    case "temporary-upstream": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE;
    }
    case "binding-drift": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.BINDING_CHANGED;
    }
  }
}

function externalErrorCode(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return null;
  }
  return error.code;
}

function externalErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function temporaryUpstreamStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function incompatibleRemoteFailureReason(
  operation: AutomaticOAuthRemoteOperation,
): AutomaticOAuthIncompatibleReason {
  switch (operation) {
    case "MCP authorization challenge": {
      return "invalid-authentication-response";
    }
    case "dynamic client registration": {
      return "invalid-registration";
    }
    case "authorization request": {
      return "unsupported-authorization";
    }
    default: {
      return "invalid-discovery-metadata";
    }
  }
}

function automaticOAuthRemoteFailure(
  operation: AutomaticOAuthRemoteOperation,
  error: unknown,
): CustomConnectorAutomaticOAuthError {
  if (error instanceof CustomConnectorAutomaticOAuthError) {
    return error;
  }
  if (error instanceof RegistrationRejectedError) {
    return new CustomConnectorAutomaticOAuthError(
      temporaryUpstreamStatus(error.status)
        ? { kind: "temporary", reason: "temporary-upstream" }
        : { kind: "incompatible", reason: "registration-rejected" },
      `MCP OAuth ${operation} failed`,
      error,
    );
  }
  if (error instanceof IssuerMismatchError || error instanceof z.ZodError) {
    return new CustomConnectorAutomaticOAuthError(
      {
        kind: "incompatible",
        reason:
          operation === "dynamic client registration"
            ? "invalid-registration"
            : "invalid-discovery-metadata",
      },
      `MCP OAuth ${operation} returned incompatible metadata`,
      error,
    );
  }
  if (error instanceof McpOAuthUnsafeUrlError) {
    return new CustomConnectorAutomaticOAuthError(
      { kind: "unsafe", reason: "unsafe-url" },
      `MCP OAuth ${operation} used an unsafe URL`,
      error,
    );
  }
  const message = externalErrorMessage(error);
  const code = externalErrorCode(error);
  if (
    code === "server_error" ||
    code === "temporarily_unavailable" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    /HTTP (?:408|429|5\d\d)/u.test(message) ||
    /timed? ?out|aborted|socket|network/iu.test(message)
  ) {
    return new CustomConnectorAutomaticOAuthError(
      { kind: "temporary", reason: "temporary-upstream" },
      `MCP OAuth ${operation} is temporarily unavailable`,
      error,
    );
  }
  return new CustomConnectorAutomaticOAuthError(
    {
      kind: "incompatible",
      reason: incompatibleRemoteFailureReason(operation),
    },
    `MCP OAuth ${operation} is not compatible with Automatic OAuth`,
    error,
  );
}

async function automaticOAuthRemote<T>(
  operation: AutomaticOAuthRemoteOperation,
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  const result = await settle(task(), signal);
  if (!result.ok) {
    throw automaticOAuthRemoteFailure(operation, result.error);
  }
  return result.value;
}

function fetchWithSignal(signal: AbortSignal): typeof mcpOAuthSafeFetch {
  return async (input, init) => {
    const requestSignal = new Request(input, init).signal;
    return await mcpOAuthSafeFetch(input, {
      ...init,
      signal: AbortSignal.any([requestSignal, signal]),
    });
  };
}

class AutomaticOAuthChallengeCaptured extends Error {
  readonly context: CapturedUnauthorizedContext;

  constructor(context: CapturedUnauthorizedContext) {
    super("MCP OAuth challenge captured");
    this.name = "AutomaticOAuthChallengeCaptured";
    this.context = context;
  }
}

interface CapturedUnauthorizedContext {
  readonly response: Response;
  readonly serverUrl: URL;
  readonly fetchFn: FetchLike;
}

async function probeAutomaticOAuthChallenge(
  endpoint: string,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "oauth"; readonly context: CapturedUnauthorizedContext }
> {
  const authProvider: AuthProvider = {
    token: () => {
      return Promise.resolve(undefined);
    },
    onUnauthorized: (context) => {
      return Promise.reject(new AutomaticOAuthChallengeCaptured(context));
    },
  };
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider,
    fetch: fetchWithSignal(signal),
    onInsufficientScope: "throw",
  });
  const client = new Client({ name: "Okou", version: "1.0.0" });
  const connection = await settle(client.connect(transport), signal);
  await transport.close();
  signal.throwIfAborted();
  if (!connection.ok) {
    if (connection.error instanceof AutomaticOAuthChallengeCaptured) {
      return { kind: "oauth", context: connection.error.context };
    }
    throw connection.error;
  }
  return { kind: "none" };
}

function requiredHttpsUrl(value: string, field: string): string {
  const parsed = z.string().url().safeParse(value);
  if (!parsed.success) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      `MCP OAuth ${field} must be a URL`,
    );
  }
  if (new URL(parsed.data).protocol !== "https:") {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "unsafe", reason: "unsafe-url" },
      `MCP OAuth ${field} must use HTTPS`,
    );
  }
  return parsed.data;
}

function scopeTokens(scope: string | undefined): readonly string[] {
  if (!scope) {
    return [];
  }
  return [...new Set(scope.split(/\s+/u).filter(Boolean))];
}

function selectedScope(
  challengeScope: string | undefined,
  metadata: OAuthProtectedResourceMetadata,
): string | undefined {
  if (challengeScope) {
    return scopeTokens(challengeScope).join(" ");
  }
  const supported = metadata.scopes_supported;
  return supported && supported.length > 0
    ? scopeTokens(supported.join(" ")).join(" ")
    : undefined;
}

interface DiscoveredAutomaticOAuthAuthority {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string | null;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly authorizationResponseIssParameterSupported: boolean;
  readonly scope: string | undefined;
  readonly protectedResourceMetadata: OAuthProtectedResourceMetadata;
  readonly authorizationServerMetadata: AuthorizationServerMetadata;
}

async function discoverAutomaticOAuthAuthority(
  args: {
    readonly endpoint: string;
    readonly resourceMetadataUrl: URL | null;
    readonly challengeScope?: string;
    readonly expectedIssuer?: string;
  },
  signal: AbortSignal,
): Promise<DiscoveredAutomaticOAuthAuthority> {
  const fetchFn = fetchWithSignal(signal);
  const protectedResourceMetadata = await automaticOAuthRemote(
    "protected resource discovery",
    signal,
    async () => {
      return await discoverOAuthProtectedResourceMetadata(
        args.endpoint,
        args.resourceMetadataUrl
          ? { resourceMetadataUrl: args.resourceMetadataUrl }
          : undefined,
        fetchFn,
      );
    },
  );
  const expectedResource = resourceUrlFromServerUrl(args.endpoint).href;
  const resource = new URL(
    requiredHttpsUrl(protectedResourceMetadata.resource, "protected resource"),
  ).href;
  if (resource !== expectedResource) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      "MCP OAuth protected resource metadata does not match the connector endpoint",
    );
  }
  const advertisedIssuers = protectedResourceMetadata.authorization_servers;
  const advertisedIssuer = args.expectedIssuer
    ? advertisedIssuers?.find((candidate) => {
        return candidate === args.expectedIssuer;
      })
    : advertisedIssuers?.[0];
  if (!advertisedIssuer) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      args.expectedIssuer
        ? "MCP OAuth protected resource metadata no longer advertises the bound authorization server"
        : "MCP OAuth protected resource metadata does not advertise an authorization server",
    );
  }
  const issuer = requiredHttpsUrl(advertisedIssuer, "issuer");
  const authorizationServerMetadata = await automaticOAuthRemote(
    "authorization server discovery",
    signal,
    async () => {
      return await discoverAuthorizationServerMetadata(issuer, {
        fetchFn,
      });
    },
  );
  if (!authorizationServerMetadata) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      "MCP OAuth authorization server metadata was not found",
    );
  }
  if (
    requiredHttpsUrl(authorizationServerMetadata.issuer, "metadata issuer") !==
    issuer
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      "MCP OAuth authorization server metadata issuer does not match",
    );
  }
  const authorizationEndpoint = await automaticOAuthRemote(
    "authorization endpoint validation",
    signal,
    async () => {
      return await validateMcpOAuthPublicUrl(
        requiredHttpsUrl(
          authorizationServerMetadata.authorization_endpoint,
          "authorization endpoint",
        ),
        signal,
      );
    },
  );
  const tokenEndpointValue = authorizationServerMetadata.token_endpoint;
  if (!tokenEndpointValue) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      "MCP OAuth authorization server does not advertise a token endpoint",
    );
  }
  const tokenEndpoint = requiredHttpsUrl(tokenEndpointValue, "token endpoint");
  if (
    !authorizationServerMetadata.response_types_supported.includes("code") ||
    !authorizationServerMetadata.code_challenge_methods_supported?.includes(
      "S256",
    )
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "unsupported-authorization" },
      "MCP OAuth authorization server does not support authorization code with PKCE S256",
    );
  }
  return {
    issuer,
    resource,
    resourceMetadataUrl: args.resourceMetadataUrl?.toString() ?? null,
    authorizationEndpoint,
    tokenEndpoint,
    authorizationResponseIssParameterSupported:
      authorizationServerMetadata.authorization_response_iss_parameter_supported ===
      true,
    scope: selectedScope(args.challengeScope, protectedResourceMetadata),
    protectedResourceMetadata,
    authorizationServerMetadata,
  };
}

export function customConnectorAutomaticOAuthResourceMatchesEndpoint(
  resource: string,
  endpoint: string,
): boolean {
  return resource === resourceUrlFromServerUrl(endpoint).href;
}

type PersistedDcrRegistration =
  typeof orgCustomConnectorDcrRegistrations.$inferSelect;

async function readDcrRegistration(args: {
  readonly db: Db;
  readonly customConnectorId: string;
  readonly issuer: string;
}): Promise<PersistedDcrRegistration | null> {
  const [registration] = await args.db
    .select()
    .from(orgCustomConnectorDcrRegistrations)
    .where(
      and(
        eq(
          orgCustomConnectorDcrRegistrations.customConnectorId,
          args.customConnectorId,
        ),
        eq(orgCustomConnectorDcrRegistrations.issuer, args.issuer),
      ),
    )
    .limit(1);
  return registration ?? null;
}

function supportedTokenAuthMethods(
  metadata: AuthorizationServerMetadata,
): readonly string[] {
  return metadata.token_endpoint_auth_methods_supported ?? [];
}

function registrationCoversScope(
  registration: PersistedDcrRegistration,
  scope: string | undefined,
): boolean {
  const registered = new Set(registration.registeredScopes);
  return scopeTokens(scope).every((item) => {
    return registered.has(item);
  });
}

function reusableDcrRegistration(args: {
  readonly registration: PersistedDcrRegistration;
  readonly redirectUri: string;
  readonly scope: string | undefined;
  readonly metadata: AuthorizationServerMetadata;
}): boolean {
  const hasSecret = args.registration.encryptedClientSecret !== null;
  const secretShapeMatches =
    args.registration.tokenEndpointAuthMethod === "none"
      ? !hasSecret
      : hasSecret;
  const supportedMethods = supportedTokenAuthMethods(args.metadata);
  return (
    args.registration.redirectUri === args.redirectUri &&
    (args.registration.expiresAt === null ||
      args.registration.expiresAt > nowDate()) &&
    secretShapeMatches &&
    (supportedMethods.length === 0 ||
      supportedMethods.includes(args.registration.tokenEndpointAuthMethod)) &&
    registrationCoversScope(args.registration, args.scope)
  );
}

async function linkedDcrAccountIds(
  db: Db,
  registrationId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: customConnectorAccountOauthBindings.connectorAccountId })
    .from(customConnectorAccountOauthBindings)
    .where(
      eq(customConnectorAccountOauthBindings.dcrRegistrationId, registrationId),
    );
  return rows.map((row) => {
    return row.id;
  });
}

export async function retireCustomConnectorDcrRegistration(
  db: Db,
  registrationId: string,
): Promise<void> {
  const accountIds = await linkedDcrAccountIds(db, registrationId);
  if (accountIds.length > 0) {
    await db
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: nowDate(),
      })
      .where(inArray(connectors.id, accountIds));
    await db
      .delete(customConnectorAccountOauthBindings)
      .where(
        eq(
          customConnectorAccountOauthBindings.dcrRegistrationId,
          registrationId,
        ),
      );
  }
  await db
    .delete(orgCustomConnectorDcrRegistrations)
    .where(eq(orgCustomConnectorDcrRegistrations.id, registrationId));
}

type AutomaticOAuthClientSelection =
  | {
      readonly clientId: string;
      readonly tokenEndpointAuthMethod: "none";
      readonly registrationMethod: "cimd";
    }
  | {
      readonly clientId: string;
      readonly tokenEndpointAuthMethod:
        | "none"
        | "client_secret_basic"
        | "client_secret_post";
      readonly registrationMethod: "dcr";
      readonly dcrRegistrationId: string;
    };

function dcrSelection(
  registration: PersistedDcrRegistration,
): AutomaticOAuthClientSelection {
  return {
    clientId: registration.clientId,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
    registrationMethod: "dcr",
    dcrRegistrationId: registration.id,
  };
}

const dcrClientInformationSchema = z.object({
  client_id: z.string().min(1).max(255),
  client_secret: z.string().min(1).optional(),
  client_id_issued_at: z.number().finite().nonnegative().optional(),
  client_secret_expires_at: z.number().finite().nonnegative().optional(),
  token_endpoint_auth_method: tokenEndpointAuthMethodSchema.optional(),
  scope: z.string().optional(),
});

function dcrRegistrationTimes(client: {
  readonly client_id_issued_at?: number;
  readonly client_secret_expires_at?: number;
}): { readonly issuedAt: Date; readonly expiresAt: Date | null } {
  const issuedAt =
    client.client_id_issued_at === undefined
      ? nowDate()
      : new Date(client.client_id_issued_at * 1000);
  const expiresAt =
    client.client_secret_expires_at === undefined ||
    client.client_secret_expires_at === 0
      ? null
      : new Date(client.client_secret_expires_at * 1000);
  if (
    !Number.isFinite(issuedAt.getTime()) ||
    (expiresAt !== null &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt))
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-registration" },
      "MCP OAuth dynamic registration returned invalid lifetime values",
    );
  }
  return { issuedAt, expiresAt };
}

function dcrTokenAuthMethod(args: {
  readonly client: z.infer<typeof dcrClientInformationSchema>;
  readonly metadata: AuthorizationServerMetadata;
}): AutomaticOAuthClientSelection["tokenEndpointAuthMethod"] {
  const supportedMethods = supportedTokenAuthMethods(args.metadata);
  const selected =
    args.client.token_endpoint_auth_method ??
    selectClientAuthMethod(args.client, [...supportedMethods]);
  if (
    (supportedMethods.length > 0 && !supportedMethods.includes(selected)) ||
    (selected === "none") !== (args.client.client_secret === undefined)
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-registration" },
      "MCP OAuth dynamic registration returned incompatible client authentication",
    );
  }
  return selected;
}

async function createDcrRegistration(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly customConnectorId: string;
    readonly issuer: string;
    readonly redirectUri: string;
    readonly scope: string | undefined;
    readonly metadata: AuthorizationServerMetadata;
    readonly clientMetadata: OAuthClientMetadata;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<PersistedDcrRegistration> {
  const client = await automaticOAuthRemote(
    "dynamic client registration",
    signal,
    async () => {
      const registered = await registerClient(args.issuer, {
        metadata: args.metadata,
        clientMetadata: args.clientMetadata,
        scope: args.scope,
        fetchFn: fetchWithSignal(signal),
      });
      return dcrClientInformationSchema.parse(registered);
    },
  );
  const tokenEndpointAuthMethod = dcrTokenAuthMethod({
    client,
    metadata: args.metadata,
  });
  const encryptedClientSecret = client.client_secret
    ? await encryptStoredSecretValue(client.client_secret, args.featureContext)
    : null;
  signal.throwIfAborted();
  const times = dcrRegistrationTimes(client);
  const [stored] = await args.db
    .insert(orgCustomConnectorDcrRegistrations)
    .values({
      orgId: args.orgId,
      customConnectorId: args.customConnectorId,
      issuer: args.issuer,
      clientId: client.client_id,
      encryptedClientSecret,
      tokenEndpointAuthMethod,
      registeredScopes: [...scopeTokens(client.scope ?? args.scope)],
      redirectUri: args.redirectUri,
      issuedAt: times.issuedAt,
      expiresAt: times.expiresAt,
    })
    .returning();
  if (!stored) {
    throw new Error("Failed to persist MCP OAuth dynamic registration");
  }
  return stored;
}

async function resolveAutomaticOAuthClient(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly customConnectorId: string;
    readonly storageVersion: number;
    readonly endpoint: string;
    readonly issuer: string;
    readonly redirectUri: string;
    readonly scope: string | undefined;
    readonly metadata: AuthorizationServerMetadata;
    readonly cimdClientId: string;
    readonly dcrClientMetadata: OAuthClientMetadata;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<AutomaticOAuthClientSelection> {
  const existing = await readDcrRegistration(args);
  if (
    existing &&
    reusableDcrRegistration({
      registration: existing,
      redirectUri: args.redirectUri,
      scope: args.scope,
      metadata: args.metadata,
    })
  ) {
    return dcrSelection(existing);
  }
  if (args.metadata.client_id_metadata_document_supported === true) {
    return {
      clientId: requiredHttpsUrl(args.cimdClientId, "Okou client ID"),
      tokenEndpointAuthMethod: "none",
      registrationMethod: "cimd",
    };
  }
  if (!args.metadata.registration_endpoint) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "incompatible", reason: "registration-unavailable" },
      "MCP OAuth server requires a Custom OAuth app",
    );
  }
  return await args.db.transaction(async (tx) => {
    const [definition] = await tx
      .select({
        authMode: orgCustomConnectors.authMode,
        storageVersion: orgCustomConnectors.storageVersion,
        endpoint: orgCustomConnectors.mcpEndpoint,
      })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.customConnectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !definition ||
      definition.authMode !== "automatic" ||
      definition.storageVersion !== args.storageVersion ||
      definition.endpoint !== args.endpoint
    ) {
      throw new Error(
        "Custom connector credential contract changed during Automatic OAuth registration",
      );
    }
    const lockedExisting = await readDcrRegistration({ ...args, db: tx });
    if (
      lockedExisting &&
      reusableDcrRegistration({
        registration: lockedExisting,
        redirectUri: args.redirectUri,
        scope: args.scope,
        metadata: args.metadata,
      })
    ) {
      return dcrSelection(lockedExisting);
    }
    if (lockedExisting) {
      const linkedAccounts = await linkedDcrAccountIds(tx, lockedExisting.id);
      const expired =
        lockedExisting.expiresAt !== null &&
        lockedExisting.expiresAt <= nowDate();
      if (linkedAccounts.length > 0 && !expired) {
        throw new CustomConnectorAutomaticOAuthError(
          { kind: "incompatible", reason: "registration-conflict" },
          "Existing MCP OAuth registration is not compatible with the requested scopes",
        );
      }
      await retireCustomConnectorDcrRegistration(tx, lockedExisting.id);
    }
    const created = await createDcrRegistration(
      {
        ...args,
        db: tx,
        clientMetadata: args.dcrClientMetadata,
      },
      signal,
    );
    return dcrSelection(created);
  });
}

export type CustomConnectorAutomaticOAuthStateContext = {
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string | null;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly authorizationResponseIssParameterSupported: boolean;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
} & (
  | {
      readonly registrationMethod: "cimd";
      readonly dcrRegistrationId?: never;
    }
  | {
      readonly registrationMethod: "dcr";
      readonly dcrRegistrationId: string;
    }
);

export type CustomConnectorCanonicalAutomaticOAuthStateContext =
  CustomConnectorAutomaticOAuthStateContext & {
    readonly version: 2;
    readonly authMode: "automatic";
  };

interface CustomConnectorAutomaticOAuthAuthorization {
  readonly kind: "oauth";
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly requestedScope: string | null;
  readonly context: CustomConnectorCanonicalAutomaticOAuthStateContext;
}

async function discoverBoundAutomaticOAuthAuthority(
  args: {
    readonly binding: CustomConnectorAutomaticOAuthBinding;
    readonly endpoint: string;
  },
  signal: AbortSignal,
): Promise<DiscoveredAutomaticOAuthAuthority> {
  const discovered = await settle(
    discoverAutomaticOAuthAuthority(
      {
        endpoint: args.endpoint,
        resourceMetadataUrl: args.binding.resourceMetadataUrl
          ? new URL(args.binding.resourceMetadataUrl)
          : null,
        expectedIssuer: args.binding.issuer,
      },
      signal,
    ),
    signal,
  );
  if (!discovered.ok) {
    const error = discovered.error;
    if (
      error instanceof CustomConnectorAutomaticOAuthError &&
      error.kind === "temporary"
    ) {
      throw error;
    }
    if (error instanceof CustomConnectorAutomaticOAuthError) {
      throw new CustomConnectorAutomaticOAuthError(
        { kind: "binding-drift", reason: "binding-drift" },
        "MCP OAuth authority changed",
        error,
      );
    }
    throw error;
  }
  const authority = discovered.value;
  if (
    authority.issuer !== args.binding.issuer ||
    authority.resource !== args.binding.resource ||
    authority.tokenEndpoint !== args.binding.tokenEndpoint ||
    (args.binding.registrationMethod === "cimd" &&
      authority.authorizationServerMetadata
        .client_id_metadata_document_supported !== true) ||
    !(
      supportedTokenAuthMethods(authority.authorizationServerMetadata)
        .length === 0 ||
      supportedTokenAuthMethods(authority.authorizationServerMetadata).includes(
        args.binding.tokenEndpointAuthMethod,
      )
    )
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "binding-drift", reason: "binding-drift" },
      "MCP OAuth authority changed",
    );
  }
  return authority;
}

export async function prepareCustomConnectorAutomaticOAuthReauthorization(
  args: {
    readonly db: Db;
    readonly binding: CustomConnectorAutomaticOAuthBinding;
    readonly storageVersion: number;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly requestedScope: string;
    readonly state: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomConnectorAutomaticOAuthAuthorization> {
  const authority = await discoverBoundAutomaticOAuthAuthority(args, signal);
  const clientInformation = await boundClientInformation({
    ...args,
    context: boundClientContext(args.binding),
  });
  signal.throwIfAborted();
  const authorization = await automaticOAuthRemote(
    "authorization request",
    signal,
    async () => {
      return await startAuthorization(args.binding.issuer, {
        metadata: authority.authorizationServerMetadata,
        clientInformation,
        redirectUrl: args.redirectUri,
        scope: args.requestedScope,
        state: args.state,
        resource: new URL(args.binding.resource),
      });
    },
  );
  const contextBase = {
    version: 2,
    authMode: "automatic",
    connectorId: args.binding.customConnectorId,
    storageVersion: args.storageVersion,
    issuer: args.binding.issuer,
    resource: args.binding.resource,
    resourceMetadataUrl: args.binding.resourceMetadataUrl,
    authorizationEndpoint: authority.authorizationEndpoint,
    tokenEndpoint: args.binding.tokenEndpoint,
    authorizationResponseIssParameterSupported:
      authority.authorizationResponseIssParameterSupported,
    clientId: args.binding.clientId,
    tokenEndpointAuthMethod: args.binding.tokenEndpointAuthMethod,
  } as const;
  const context: CustomConnectorCanonicalAutomaticOAuthStateContext =
    args.binding.registrationMethod === "dcr"
      ? {
          ...contextBase,
          registrationMethod: "dcr",
          dcrRegistrationId: args.binding.dcrRegistration.id,
        }
      : { ...contextBase, registrationMethod: "cimd" };
  return {
    kind: "oauth",
    authorizationUrl: authorization.authorizationUrl.toString(),
    codeVerifier: authorization.codeVerifier,
    requestedScope: args.requestedScope,
    context,
  };
}

interface CustomConnectorAutomaticNoAuth {
  readonly kind: "none";
}

type AutomaticOAuthBoundClientContext = {
  readonly connectorId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
} & (
  | {
      readonly registrationMethod: "cimd";
    }
  | {
      readonly registrationMethod: "dcr";
      readonly dcrRegistrationId: string;
    }
);

export async function prepareCustomConnectorAutomaticOAuthAuthorization(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly customConnectorId: string;
    readonly storageVersion: number;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly cimdClientId: string;
    readonly dcrClientMetadata: OAuthClientMetadata;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  CustomConnectorAutomaticOAuthAuthorization | CustomConnectorAutomaticNoAuth
> {
  const probe = await automaticOAuthRemote(
    "MCP authorization challenge",
    signal,
    async () => {
      return await probeAutomaticOAuthChallenge(args.endpoint, signal);
    },
  );
  if (probe.kind === "none") {
    return probe;
  }
  const challenge = probe.context;
  const challengeParameters = extractWWWAuthenticateParams(challenge.response);
  const authority = await discoverAutomaticOAuthAuthority(
    {
      endpoint: args.endpoint,
      resourceMetadataUrl: challengeParameters.resourceMetadataUrl ?? null,
      challengeScope: challengeParameters.scope,
    },
    signal,
  );
  const client = await resolveAutomaticOAuthClient(
    {
      ...args,
      issuer: authority.issuer,
      scope: authority.scope,
      metadata: authority.authorizationServerMetadata,
    },
    signal,
  );
  const clientInformation: OAuthClientInformationMixed = {
    client_id: client.clientId,
  };
  const authorization = await automaticOAuthRemote(
    "authorization request",
    signal,
    async () => {
      return await startAuthorization(authority.issuer, {
        metadata: authority.authorizationServerMetadata,
        clientInformation,
        redirectUrl: args.redirectUri,
        scope: authority.scope,
        state: args.state,
        resource: new URL(authority.resource),
      });
    },
  );
  const contextBase = {
    version: 2,
    authMode: "automatic",
    connectorId: args.customConnectorId,
    storageVersion: args.storageVersion,
    issuer: authority.issuer,
    resource: authority.resource,
    resourceMetadataUrl: authority.resourceMetadataUrl,
    authorizationEndpoint: authority.authorizationEndpoint,
    tokenEndpoint: authority.tokenEndpoint,
    authorizationResponseIssParameterSupported:
      authority.authorizationResponseIssParameterSupported,
    clientId: client.clientId,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
  } as const;
  const context: CustomConnectorCanonicalAutomaticOAuthStateContext =
    client.registrationMethod === "dcr"
      ? {
          ...contextBase,
          registrationMethod: "dcr",
          dcrRegistrationId: client.dcrRegistrationId,
        }
      : { ...contextBase, registrationMethod: "cimd" };
  return {
    kind: "oauth",
    authorizationUrl: authorization.authorizationUrl.toString(),
    codeVerifier: authorization.codeVerifier,
    requestedScope: authority.scope ?? null,
    context,
  };
}

function frozenAuthorizationServerMetadata(
  context: Pick<
    CustomConnectorAutomaticOAuthStateContext,
    | "issuer"
    | "authorizationEndpoint"
    | "tokenEndpoint"
    | "tokenEndpointAuthMethod"
    | "authorizationResponseIssParameterSupported"
  >,
): AuthorizationServerMetadata {
  return {
    issuer: context.issuer,
    authorization_endpoint: context.authorizationEndpoint,
    token_endpoint: context.tokenEndpoint,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [context.tokenEndpointAuthMethod],
    authorization_response_iss_parameter_supported:
      context.authorizationResponseIssParameterSupported,
  };
}

async function boundClientInformation(args: {
  readonly db: Db;
  readonly context: AutomaticOAuthBoundClientContext;
  readonly redirectUri: string;
  readonly cimdClientId: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<OAuthClientInformationMixed> {
  if (args.context.registrationMethod === "cimd") {
    if (
      args.context.clientId !== args.cimdClientId ||
      args.context.tokenEndpointAuthMethod !== "none"
    ) {
      throw new CustomConnectorAutomaticOAuthError(
        { kind: "binding-drift", reason: "binding-drift" },
        "MCP OAuth client binding changed",
      );
    }
    return { client_id: args.context.clientId };
  }
  const [registration] = await args.db
    .select()
    .from(orgCustomConnectorDcrRegistrations)
    .where(
      and(
        eq(
          orgCustomConnectorDcrRegistrations.id,
          args.context.dcrRegistrationId,
        ),
        eq(
          orgCustomConnectorDcrRegistrations.customConnectorId,
          args.context.connectorId,
        ),
      ),
    )
    .limit(1);
  if (
    !registration ||
    registration.issuer !== args.context.issuer ||
    registration.clientId !== args.context.clientId ||
    registration.redirectUri !== args.redirectUri ||
    registration.tokenEndpointAuthMethod !==
      args.context.tokenEndpointAuthMethod ||
    (registration.expiresAt !== null && registration.expiresAt <= nowDate())
  ) {
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "binding-drift", reason: "binding-drift" },
      "MCP OAuth dynamic registration changed",
    );
  }
  const clientSecret = registration.encryptedClientSecret
    ? await decryptStoredSecretValue(
        registration.encryptedClientSecret,
        args.featureContext,
      )
    : undefined;
  if (
    (registration.tokenEndpointAuthMethod === "none") !==
    (clientSecret === undefined)
  ) {
    throw new Error("MCP OAuth dynamic registration secret is inconsistent");
  }
  return {
    client_id: registration.clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    token_endpoint_auth_method: registration.tokenEndpointAuthMethod,
  };
}

interface CustomConnectorAutomaticOAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
}

function automaticOAuthTokenResult(
  tokens: OAuthTokens,
): CustomConnectorAutomaticOAuthTokenResult {
  const expiresIn = tokens.expires_in;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    expiresAt:
      expiresIn === undefined
        ? null
        : new Date(nowDate().getTime() + expiresIn * 1000),
    scopes: tokens.scope === undefined ? null : scopeTokens(tokens.scope),
  };
}

export async function exchangeCustomConnectorAutomaticOAuthCode(
  args: {
    readonly db: Db;
    readonly context: CustomConnectorAutomaticOAuthStateContext;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly code: string;
    readonly iss: string | undefined;
    readonly codeVerifier: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomConnectorAutomaticOAuthTokenResult> {
  const clientInformation = await boundClientInformation(args);
  signal.throwIfAborted();
  const tokens = await exchangeAuthorization(args.context.issuer, {
    metadata: frozenAuthorizationServerMetadata(args.context),
    clientInformation,
    authorizationCode: args.code,
    iss: args.iss,
    codeVerifier: args.codeVerifier,
    redirectUri: args.redirectUri,
    resource: new URL(args.context.resource),
    fetchFn: fetchWithSignal(signal),
  });
  signal.throwIfAborted();
  return automaticOAuthTokenResult(tokens);
}

export function validateCustomConnectorAutomaticOAuthCallbackIssuer(
  context: CustomConnectorAutomaticOAuthStateContext,
  iss: string | undefined,
): void {
  validateAuthorizationResponseIssuer({
    iss,
    expectedIssuer: context.issuer,
    issParameterSupported: context.authorizationResponseIssParameterSupported,
  });
}

function boundClientContext(
  binding: CustomConnectorAutomaticOAuthBinding,
): AutomaticOAuthBoundClientContext {
  const base = {
    connectorId: binding.customConnectorId,
    issuer: binding.issuer,
    clientId: binding.clientId,
    tokenEndpointAuthMethod: binding.tokenEndpointAuthMethod,
  } as const;
  return binding.registrationMethod === "dcr"
    ? {
        ...base,
        registrationMethod: "dcr",
        dcrRegistrationId: binding.dcrRegistration.id,
      }
    : { ...base, registrationMethod: "cimd" };
}

export async function refreshCustomConnectorAutomaticOAuthToken(
  args: {
    readonly db: Db;
    readonly binding: CustomConnectorAutomaticOAuthBinding;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly refreshToken: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomConnectorAutomaticOAuthTokenResult> {
  const authority = await discoverBoundAutomaticOAuthAuthority(args, signal);
  const clientInformation = await boundClientInformation({
    ...args,
    context: boundClientContext(args.binding),
  });
  signal.throwIfAborted();
  const refreshed = await settle(
    refreshAuthorization(args.binding.issuer, {
      metadata: frozenAuthorizationServerMetadata({
        issuer: args.binding.issuer,
        authorizationEndpoint: authority.authorizationEndpoint,
        tokenEndpoint: args.binding.tokenEndpoint,
        tokenEndpointAuthMethod: args.binding.tokenEndpointAuthMethod,
        authorizationResponseIssParameterSupported:
          authority.authorizationResponseIssParameterSupported,
      }),
      clientInformation,
      refreshToken: args.refreshToken,
      resource: new URL(args.binding.resource),
      fetchFn: fetchWithSignal(signal),
    }),
    signal,
  );
  if (!refreshed.ok) {
    const error = refreshed.error;
    if (error instanceof OAuthError) {
      if (
        error.code === "server_error" ||
        error.code === "temporarily_unavailable"
      ) {
        throw new CustomConnectorAutomaticOAuthError(
          { kind: "temporary", reason: "temporary-upstream" },
          "MCP OAuth token refresh is temporarily unavailable",
          error,
        );
      }
      throw error;
    }
    const remoteFailure = automaticOAuthRemoteFailure("token refresh", error);
    if (remoteFailure.kind === "temporary") {
      throw remoteFailure;
    }
    throw new CustomConnectorAutomaticOAuthError(
      { kind: "binding-drift", reason: "binding-drift" },
      "MCP OAuth token authority changed",
      remoteFailure,
    );
  }
  return automaticOAuthTokenResult(refreshed.value);
}

export function isAutomaticOAuthInvalidClient(error: unknown): boolean {
  return error instanceof OAuthError && error.code === "invalid_client";
}

export function isAutomaticOAuthInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === "invalid_grant";
}
