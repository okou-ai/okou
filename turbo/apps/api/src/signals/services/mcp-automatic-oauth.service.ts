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
import { z } from "zod";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  McpOAuthUnsafeUrlError,
  mcpOAuthSafeFetch,
  validateMcpOAuthPublicUrl,
} from "./mcp-oauth-safe-fetch.service";

export interface McpAutomaticOAuthDcrRegistration {
  readonly id: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
  readonly hasClientSecret: boolean;
  readonly registeredScopes: readonly string[];
  readonly redirectUri: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
}

const tokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

export interface McpAutomaticOAuthDcrClientStore {
  readBoundClient(registrationId: string): Promise<
    | (McpAutomaticOAuthDcrRegistration & {
        readonly clientSecret: string | undefined;
      })
    | null
  >;
}

/** Owner adapters enforce registration identity, encryption and transaction locks. */
export interface McpAutomaticOAuthDcrStore extends McpAutomaticOAuthDcrClientStore {
  readByIssuer(
    issuer: string,
  ): Promise<McpAutomaticOAuthDcrRegistration | null>;
  withLock<T>(
    operation: (store: McpAutomaticOAuthDcrStore) => Promise<T>,
  ): Promise<T>;
  hasLinkedAccounts(registrationId: string): Promise<boolean>;
  retire(registrationId: string): Promise<void>;
  create(
    registration: Omit<
      McpAutomaticOAuthDcrRegistration,
      "id" | "hasClientSecret"
    > & {
      readonly clientSecret: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<McpAutomaticOAuthDcrRegistration>;
}

export type McpAutomaticOAuthBinding = {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string | null;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly tokenEndpointAuthMethod:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
} & (
  | { readonly registrationMethod: "cimd"; readonly dcrRegistration: null }
  | {
      readonly registrationMethod: "dcr";
      readonly dcrRegistration: McpAutomaticOAuthDcrRegistration;
    }
);

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
  | "authorization-code exchange"
  | "token refresh";

export class McpAutomaticOAuthError extends Error {
  readonly kind: AutomaticOAuthFailureKind;
  readonly reason: AutomaticOAuthFailure["reason"];

  constructor(
    failure: AutomaticOAuthFailure,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpAutomaticOAuthError";
    this.kind = failure.kind;
    this.reason = failure.reason;
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
): McpAutomaticOAuthError {
  if (error instanceof McpAutomaticOAuthError) {
    return error;
  }
  if (error instanceof RegistrationRejectedError) {
    return new McpAutomaticOAuthError(
      temporaryUpstreamStatus(error.status)
        ? { kind: "temporary", reason: "temporary-upstream" }
        : { kind: "incompatible", reason: "registration-rejected" },
      `MCP OAuth ${operation} failed`,
      error,
    );
  }
  if (error instanceof IssuerMismatchError || error instanceof z.ZodError) {
    return new McpAutomaticOAuthError(
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
    return new McpAutomaticOAuthError(
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
    return new McpAutomaticOAuthError(
      { kind: "temporary", reason: "temporary-upstream" },
      `MCP OAuth ${operation} is temporarily unavailable`,
      error,
    );
  }
  return new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      `MCP OAuth ${field} must be a URL`,
    );
  }
  if (new URL(parsed.data).protocol !== "https:") {
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-discovery-metadata" },
      "MCP OAuth authorization server metadata was not found",
    );
  }
  if (
    requiredHttpsUrl(authorizationServerMetadata.issuer, "metadata issuer") !==
    issuer
  ) {
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
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

export function mcpAutomaticOAuthResourceMatchesEndpoint(
  resource: string,
  endpoint: string,
): boolean {
  return resource === resourceUrlFromServerUrl(endpoint).href;
}

function supportedTokenAuthMethods(
  metadata: AuthorizationServerMetadata,
): readonly string[] {
  return metadata.token_endpoint_auth_methods_supported ?? [];
}

function registrationCoversScope(
  registration: McpAutomaticOAuthDcrRegistration,
  scope: string | undefined,
): boolean {
  const registered = new Set(registration.registeredScopes);
  return scopeTokens(scope).every((item) => {
    return registered.has(item);
  });
}

function reusableDcrRegistration(args: {
  readonly registration: McpAutomaticOAuthDcrRegistration;
  readonly redirectUri: string;
  readonly scope: string | undefined;
  readonly metadata: AuthorizationServerMetadata;
}): boolean {
  const hasSecret = args.registration.hasClientSecret;
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
  registration: McpAutomaticOAuthDcrRegistration,
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
    throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
      { kind: "incompatible", reason: "invalid-registration" },
      "MCP OAuth dynamic registration returned incompatible client authentication",
    );
  }
  return selected;
}

async function createDcrRegistration(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrStore;
    readonly issuer: string;
    readonly redirectUri: string;
    readonly scope: string | undefined;
    readonly metadata: AuthorizationServerMetadata;
    readonly clientMetadata: OAuthClientMetadata;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthDcrRegistration> {
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
  signal.throwIfAborted();
  const times = dcrRegistrationTimes(client);
  return await args.dcrStore.create(
    {
      issuer: args.issuer,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      tokenEndpointAuthMethod,
      registeredScopes: [...scopeTokens(client.scope ?? args.scope)],
      redirectUri: args.redirectUri,
      issuedAt: times.issuedAt,
      expiresAt: times.expiresAt,
    },
    signal,
  );
}

async function resolveAutomaticOAuthClient(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrStore;
    readonly issuer: string;
    readonly redirectUri: string;
    readonly scope: string | undefined;
    readonly metadata: AuthorizationServerMetadata;
    readonly cimdClientId: string;
    readonly dcrClientMetadata: OAuthClientMetadata;
  },
  signal: AbortSignal,
): Promise<AutomaticOAuthClientSelection> {
  const existing = await args.dcrStore.readByIssuer(args.issuer);
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
    throw new McpAutomaticOAuthError(
      { kind: "incompatible", reason: "registration-unavailable" },
      "MCP OAuth server requires a Custom OAuth app",
    );
  }
  return await args.dcrStore.withLock(async (store) => {
    const lockedExisting = await store.readByIssuer(args.issuer);
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
      const hasLinkedAccounts = await store.hasLinkedAccounts(
        lockedExisting.id,
      );
      const expired =
        lockedExisting.expiresAt !== null &&
        lockedExisting.expiresAt <= nowDate();
      if (hasLinkedAccounts && !expired) {
        throw new McpAutomaticOAuthError(
          { kind: "incompatible", reason: "registration-conflict" },
          "Existing MCP OAuth registration is not compatible with the requested scopes",
        );
      }
      await store.retire(lockedExisting.id);
    }
    const created = await createDcrRegistration(
      {
        ...args,
        dcrStore: store,
        clientMetadata: args.dcrClientMetadata,
      },
      signal,
    );
    return dcrSelection(created);
  });
}

export type McpAutomaticOAuthContext = {
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

export interface McpAutomaticOAuthAuthorization {
  readonly kind: "oauth";
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly requestedScope: string | null;
  readonly context: McpAutomaticOAuthContext;
}

async function discoverBoundAutomaticOAuthAuthority(
  args: {
    readonly binding: McpAutomaticOAuthBinding;
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
    if (error instanceof McpAutomaticOAuthError && error.kind === "temporary") {
      throw error;
    }
    if (error instanceof McpAutomaticOAuthError) {
      throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
      { kind: "binding-drift", reason: "binding-drift" },
      "MCP OAuth authority changed",
    );
  }
  return authority;
}

export async function prepareMcpAutomaticOAuthReauthorization(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrClientStore;
    readonly binding: McpAutomaticOAuthBinding;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly requestedScope: string;
    readonly state: string;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthAuthorization> {
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
  const context: McpAutomaticOAuthContext =
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

export interface McpAutomaticNoAuth {
  readonly kind: "none";
}

type AutomaticOAuthBoundClientContext = {
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

export async function prepareMcpAutomaticOAuthAuthorization(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrStore;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly cimdClientId: string;
    readonly dcrClientMetadata: OAuthClientMetadata;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthAuthorization | McpAutomaticNoAuth> {
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
  const context: McpAutomaticOAuthContext =
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
    McpAutomaticOAuthContext,
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
  readonly dcrStore: McpAutomaticOAuthDcrClientStore;
  readonly context: AutomaticOAuthBoundClientContext;
  readonly redirectUri: string;
  readonly cimdClientId: string;
}): Promise<OAuthClientInformationMixed> {
  if (args.context.registrationMethod === "cimd") {
    if (
      args.context.clientId !== args.cimdClientId ||
      args.context.tokenEndpointAuthMethod !== "none"
    ) {
      throw new McpAutomaticOAuthError(
        { kind: "binding-drift", reason: "binding-drift" },
        "MCP OAuth client binding changed",
      );
    }
    return { client_id: args.context.clientId };
  }
  const registration = await args.dcrStore.readBoundClient(
    args.context.dcrRegistrationId,
  );
  if (
    !registration ||
    registration.issuer !== args.context.issuer ||
    registration.clientId !== args.context.clientId ||
    registration.redirectUri !== args.redirectUri ||
    registration.tokenEndpointAuthMethod !==
      args.context.tokenEndpointAuthMethod ||
    (registration.expiresAt !== null && registration.expiresAt <= nowDate())
  ) {
    throw new McpAutomaticOAuthError(
      { kind: "binding-drift", reason: "binding-drift" },
      "MCP OAuth dynamic registration changed",
    );
  }
  const clientSecret = registration.clientSecret;
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

export interface McpAutomaticOAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
}

function automaticOAuthTokenResult(
  tokens: OAuthTokens,
): McpAutomaticOAuthTokenResult {
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

export async function exchangeMcpAutomaticOAuthCode(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrClientStore;
    readonly context: McpAutomaticOAuthContext;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly code: string;
    readonly iss: string | undefined;
    readonly codeVerifier: string;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthTokenResult> {
  const clientInformation = await boundClientInformation(args);
  signal.throwIfAborted();
  const exchanged = await settle(
    exchangeAuthorization(args.context.issuer, {
      metadata: frozenAuthorizationServerMetadata(args.context),
      clientInformation,
      authorizationCode: args.code,
      iss: args.iss,
      codeVerifier: args.codeVerifier,
      redirectUri: args.redirectUri,
      resource: new URL(args.context.resource),
      fetchFn: fetchWithSignal(signal),
    }),
    signal,
  );
  signal.throwIfAborted();
  if (!exchanged.ok) {
    if (
      isAutomaticOAuthInvalidClient(exchanged.error) ||
      isAutomaticOAuthInvalidGrant(exchanged.error)
    ) {
      throw exchanged.error;
    }
    throw automaticOAuthRemoteFailure(
      "authorization-code exchange",
      exchanged.error,
    );
  }
  return automaticOAuthTokenResult(exchanged.value);
}

export function validateMcpAutomaticOAuthCallbackIssuer(
  context: McpAutomaticOAuthContext,
  iss: string | undefined,
): void {
  validateAuthorizationResponseIssuer({
    iss,
    expectedIssuer: context.issuer,
    issParameterSupported: context.authorizationResponseIssParameterSupported,
  });
}

function boundClientContext(
  binding: McpAutomaticOAuthBinding,
): AutomaticOAuthBoundClientContext {
  const base = {
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

export async function refreshMcpAutomaticOAuthToken(
  args: {
    readonly dcrStore: McpAutomaticOAuthDcrClientStore;
    readonly binding: McpAutomaticOAuthBinding;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<McpAutomaticOAuthTokenResult> {
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
        throw new McpAutomaticOAuthError(
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
    throw new McpAutomaticOAuthError(
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
