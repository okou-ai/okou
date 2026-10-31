import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { customOAuthConnectionPublicationSql } from "./custom-oauth-connection-publication";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY } from "./get-started-rewards.service";
import { feishuPlatformFromTokenUrl } from "@okouai/core/feishu-platform";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  never as zNever,
  url as zUrl,
  type infer as zInfer,
} from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import {
  mcpOAuthScopeListSchema,
  mcpOAuthScopeTokenSchema,
} from "@okouai/api-contracts/contracts/mcp-connectors";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { OAuthClientMetadata } from "@modelcontextprotocol/client";
import {
  isIntegrationManagedCustomConnector,
  isIntegrationManagedCustomConnectorProviderAdapter,
  type CustomConnectorOAuthProviderAdapter,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  isOAuthProviderHttpError,
  OAuthProviderHttpError,
} from "@okouai/connectors/auth-providers/oauth/error";
import { connectors } from "@okouai/db/schema/connector";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import { secrets } from "@okouai/db/schema/secret";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { safeJsonParse, settle } from "../utils";
import { db$, writeDb$ } from "../external/db";
import {
  exchangeFeishuOAuthCode,
  FeishuOAuthTokenError,
  refreshFeishuOAuthToken,
} from "../external/feishu-client";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
  getCustomConnectorById,
  integrationManagedCustomConnectorMutationForbidden,
  normaliseCustomConnectorRow,
  serialiseCustomConnector,
  type CustomConnectorOAuthConfigRow,
  type CustomConnectorRow,
} from "./custom-connector.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import type { StoredCustomConnectorOAuthState } from "./connector-oauth-state.service";
import {
  type ConnectorConnectionMutationResolution,
  existingConnectorConnectionSelection,
  connectorConnectionMutationReadPlan as connectionMutationReadPlan,
  connectorConnectionMutationReadResult as connectionMutationReadResult,
  type ConnectorConnectionMutationArgs,
  type ConnectorConnectionWriteArgs,
} from "./connector-connection-write.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import {
  addUserCustomConnector$,
  type AddUserCustomConnectorResult,
} from "./user-connectors.service";
import {
  connectorRuntimeWakeupRunColumns,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  reportConnectorRuntimeWakeupDiscoveryFailure,
  uniqueConnectorRuntimeTargets,
  type ConnectorRuntimeWakeupBusinessArgs,
} from "./connector-runtime-wakeup.service";
import type { CapturedConnectorClientInvalidationAbort } from "./connector-client-invalidation.service";
import { mcpOAuthSafeFetch } from "./mcp-oauth-safe-fetch.service";
import {
  customConnectorAutomaticOAuthErrorCode,
  prepareCustomConnectorAutomaticOAuthAuthorization$,
  prepareCustomConnectorAutomaticOAuthReauthorization$,
  refreshCustomConnectorAutomaticOAuthToken$,
  customConnectorAutomaticOAuthBindingReadPlan,
  customConnectorAutomaticOAuthBindingFromRow,
  retireCustomConnectorDcrRegistrationSql,
  type CustomConnectorAutomaticOAuthBinding,
  type CustomConnectorAutomaticOAuthAuthorization,
  type CustomConnectorCanonicalAutomaticOAuthStateContext as PreparedCustomConnectorAutomaticOAuthStateContext,
} from "./custom-connector-automatic-oauth.service";
import {
  McpAutomaticOAuthError,
  isAutomaticOAuthInvalidClient,
  isAutomaticOAuthInvalidGrant,
} from "./mcp-automatic-oauth.service";
import {
  discoverStaticCustomOAuthUserInfo,
  resolveRefreshedOAuthIdentity,
  type McpAutomaticOAuthUserInfo,
} from "./mcp-oauth-identity.service";
import { configuredOkouMcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.service";
import {
  automaticNoAuthPublicationSql,
  customConnectorOAuthStartFromRow,
  customConnectorOAuthStartResultSchema,
  customConnectorOAuthStartSql,
  customConnectorOAuthConnectionReadPlan,
  customConnectorOAuthConnectionTokenReadPlan,
  customConnectorRefreshReconnectCondition,
  storedRefreshTokenCondition,
  type CustomConnectorOAuthConnectionReadIdentity,
} from "./custom-connector-oauth-write.service";

const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

const oauthHttpsUrlSchema = zUrl().refine((value) => {
  return new URL(value).protocol === "https:";
});

const customConnectorCustomOAuthProviderContextSchema = object({
  provider: literal("feishu"),
  completionTarget: zEnum(["custom", "feishu"]),
  installationId: uuid().optional(),
  expectedOpenId: string().min(1).optional(),
}).strict();

const customConnectorCustomOAuthStateContextSchema = object({
  version: literal(2),
  authMode: literal("oauth"),
  connectorId: uuid(),
  storageVersion: number().int().positive(),
  providerContext: customConnectorCustomOAuthProviderContextSchema.optional(),
}).strict();

export type CustomConnectorCustomOAuthStateContext = zInfer<
  typeof customConnectorCustomOAuthStateContextSchema
>;

const customConnectorAutomaticOAuthStateContextCoreSchema = object({
  connectorId: uuid(),
  storageVersion: number().int().positive(),
  issuer: oauthHttpsUrlSchema,
  resource: oauthHttpsUrlSchema,
  resourceMetadataUrl: oauthHttpsUrlSchema.nullable(),
  authorizationEndpoint: oauthHttpsUrlSchema,
  tokenEndpoint: oauthHttpsUrlSchema,
  authorizationResponseIssParameterSupported: boolean(),
  clientId: string().min(1),
  tokenEndpointAuthMethod: zEnum([
    "none",
    "client_secret_basic",
    "client_secret_post",
  ]),
  providerContext: zNever().optional(),
});

const customConnectorAutomaticOAuthStateContextBaseSchema =
  customConnectorAutomaticOAuthStateContextCoreSchema.extend({
    version: literal(2),
    authMode: literal("automatic"),
  });

const customConnectorAutomaticOAuthStateContextSchema = union([
  customConnectorAutomaticOAuthStateContextBaseSchema
    .extend({
      registrationMethod: literal("cimd"),
      dcrRegistrationId: zNever().optional(),
    })
    .strict(),
  customConnectorAutomaticOAuthStateContextBaseSchema
    .extend({
      registrationMethod: literal("dcr"),
      dcrRegistrationId: uuid(),
    })
    .strict(),
]);

const customConnectorOAuthStateContextSchema = union([
  customConnectorCustomOAuthStateContextSchema,
  customConnectorAutomaticOAuthStateContextSchema,
]);

type CustomConnectorOAuthStateContext = zInfer<
  typeof customConnectorOAuthStateContextSchema
>;

type CustomConnectorAutomaticOAuthStateContext = zInfer<
  typeof customConnectorAutomaticOAuthStateContextSchema
>;

export function isCustomConnectorCustomOAuthStateContext(
  context: CustomConnectorOAuthStateContext,
): context is CustomConnectorCustomOAuthStateContext {
  return context.authMode === "oauth";
}

export function isCustomConnectorAutomaticOAuthStateContext(
  context: CustomConnectorOAuthStateContext,
): context is CustomConnectorAutomaticOAuthStateContext {
  return context.authMode === "automatic";
}

const oauthTokenResponseSchema = object({
  access_token: string().min(1),
  refresh_token: string().min(1).nullable().optional(),
  id_token: string().min(1).nullable().optional(),
  token_type: string().min(1).optional(),
  expires_in: union([number(), string()]).optional(),
  scope: string().trim().min(1).optional(),
});

const oauthTokenErrorResponseSchema = object({
  error: string().min(1).optional(),
  error_subtype: string().min(1).optional(),
});

export interface CustomConnectorOAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
  readonly userInfo?: McpAutomaticOAuthUserInfo | null;
}

interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface PublicHttpsResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function tokenResponseData(response: PublicHttpsResponse): unknown {
  if (
    response.contentType.toLowerCase().includes("json") ||
    response.body.trimStart().startsWith("{")
  ) {
    return safeJsonParse(response.body);
  }
  return Object.fromEntries(new URLSearchParams(response.body));
}

function expiresInSeconds(value: number | string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("OAuth token response has an invalid expires_in value");
  }
  return seconds;
}

function hasHttpHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function oauthScopeTokens(scope: string): readonly string[] {
  return scope.split(/\s+/u);
}

function customConnectorOAuth2AuthorizationScopes(
  authorizationUrl: string | null,
): readonly string[] {
  if (!authorizationUrl) {
    throw new Error("Custom connector OAuth state has no authorization URL");
  }
  const scope = new URL(authorizationUrl).searchParams.get("scope");
  return scope ? oauthScopeTokens(scope) : [];
}

export function customConnectorOAuth2EffectiveInitialToken(
  token: CustomConnectorOAuthTokenResult,
  authorizationUrl: string | null,
): CustomConnectorOAuthTokenResult {
  return token.scopes === null
    ? {
        ...token,
        scopes: customConnectorOAuth2AuthorizationScopes(authorizationUrl),
      }
    : token;
}

function tokenResult(
  response: PublicHttpsResponse,
): CustomConnectorOAuthTokenResult {
  if (response.status < 200 || response.status >= 300) {
    const parsed = oauthTokenErrorResponseSchema.safeParse(
      tokenResponseData(response),
    );
    throw new OAuthProviderHttpError(
      `Custom connector OAuth token request failed with status ${response.status}`,
      response.status,
      parsed.success ? parsed.data.error : undefined,
      parsed.success ? parsed.data.error_subtype : undefined,
    );
  }
  const parsed = oauthTokenResponseSchema.safeParse(
    tokenResponseData(response),
  );
  if (!parsed.success) {
    throw new Error("OAuth token response is invalid");
  }
  if (hasHttpHeaderControlCharacter(parsed.data.access_token)) {
    throw new Error("OAuth token response contains an invalid access token");
  }
  const expiresIn = expiresInSeconds(parsed.data.expires_in);
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    idToken: parsed.data.id_token ?? null,
    expiresAt:
      expiresIn === null
        ? null
        : new Date(nowDate().getTime() + expiresIn * 1000),
    scopes:
      parsed.data.scope === undefined
        ? null
        : oauthScopeTokens(parsed.data.scope),
  };
}

function tokenRequestAuthentication(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly clientSecret: string;
  readonly form: URLSearchParams;
}): string | undefined {
  if (args.config.tokenEndpointAuthMethod === "client_secret_post") {
    args.form.set("client_id", args.config.clientId);
    args.form.set("client_secret", args.clientSecret);
    return undefined;
  }
  return `Basic ${Buffer.from(
    `${args.config.clientId}:${args.clientSecret}`,
    "utf8",
  ).toString("base64")}`;
}

async function requestToken(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly form: URLSearchParams;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuthTokenResult> {
  const authorization = tokenRequestAuthentication(args);
  const result = await settle(
    accept(
      mcpOAuthSafeFetch(args.config.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          ...(authorization ? { authorization } : {}),
        },
        body: args.form,
        signal,
      }),
      [200],
    ),
    signal,
  );
  let fetched: Response;
  if (result.ok) {
    fetched = result.value;
  } else if (
    result.error instanceof HttpStatusError &&
    result.error.status >= 300
  ) {
    fetched = result.error.response;
  } else {
    throw result.error;
  }
  const response: PublicHttpsResponse = {
    status: fetched.status,
    contentType: fetched.headers.get("content-type") ?? "",
    body: await fetched.text(),
  };
  signal.throwIfAborted();
  return tokenResult(response);
}

function feishuOAuthTokenResult(token: {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
}): CustomConnectorOAuthTokenResult {
  if (hasHttpHeaderControlCharacter(token.accessToken)) {
    throw new Error("OAuth token response contains an invalid access token");
  }
  if (!Number.isFinite(token.expiresInSeconds) || token.expiresInSeconds < 0) {
    throw new Error("OAuth token response has an invalid expires_in value");
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    idToken: null,
    expiresAt: new Date(nowDate().getTime() + token.expiresInSeconds * 1000),
    scopes: null,
  };
}

function isFeishuInvalidGrantCode(code: number): boolean {
  return (
    code === 20_008 ||
    code === 20_009 ||
    code === 20_010 ||
    code === 20_024 ||
    code === 20_026 ||
    code === 20_037 ||
    code === 20_048 ||
    code === 20_064 ||
    code === 20_066 ||
    code === 20_069 ||
    code === 20_073 ||
    code === 20_074
  );
}

function throwCustomConnectorFeishuOAuthError(error: unknown): never {
  if (!(error instanceof FeishuOAuthTokenError)) {
    throw error;
  }
  throw new OAuthProviderHttpError(
    error.message,
    error.routeStatus,
    isFeishuInvalidGrantCode(error.code) ? "invalid_grant" : error.oauthError,
  );
}

export async function exchangeCustomConnectorOAuth2Code(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string | null;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuthTokenResult> {
  if (args.config.providerAdapter === "feishu") {
    const result = await settle(
      exchangeFeishuOAuthCode(
        {
          appId: args.config.clientId,
          platform: feishuPlatformFromTokenUrl(args.config.tokenUrl),
          appSecret: args.clientSecret,
          code: args.code,
          redirectUri: args.redirectUri,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      throwCustomConnectorFeishuOAuthError(result.error);
    }
    return feishuOAuthTokenResult(result.value);
  }
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  if (args.codeVerifier) {
    form.set("code_verifier", args.codeVerifier);
  }
  const token = await requestToken({ ...args, form }, signal);
  return {
    ...token,
    userInfo: await discoverStaticCustomOAuthUserInfo(
      {
        authorizationEndpoint: args.config.authorizationUrl,
        tokenEndpoint: args.config.tokenUrl,
        clientId: args.config.clientId,
        accessToken: token.accessToken,
        idToken: token.idToken,
      },
      signal,
    ),
  };
}

async function refreshCustomConnectorOAuth2Token(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuthTokenResult> {
  if (args.config.providerAdapter === "feishu") {
    const result = await settle(
      refreshFeishuOAuthToken(
        {
          appId: args.config.clientId,
          platform: feishuPlatformFromTokenUrl(args.config.tokenUrl),
          appSecret: args.clientSecret,
          refreshToken: args.refreshToken,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      throwCustomConnectorFeishuOAuthError(result.error);
    }
    return feishuOAuthTokenResult(result.value);
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });
  const token = await requestToken({ ...args, form }, signal);
  return {
    ...token,
    userInfo: await discoverStaticCustomOAuthUserInfo(
      {
        authorizationEndpoint: args.config.authorizationUrl,
        tokenEndpoint: args.config.tokenUrl,
        clientId: args.config.clientId,
        accessToken: token.accessToken,
        idToken: token.idToken,
      },
      signal,
    ),
  };
}

function createPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function buildCustomConnectorOAuth2AuthorizationUrl(args: {
  readonly config: CustomConnectorOAuthConfigRow;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string | null;
}): string {
  const url = new URL(args.config.authorizationUrl);
  for (const [name, value] of Object.entries(args.config.authorizationParams)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.config.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  if (args.config.scopes.length > 0) {
    url.searchParams.set("scope", args.config.scopes.join(" "));
  } else {
    url.searchParams.delete("scope");
  }
  if (args.codeVerifier) {
    url.searchParams.set("code_challenge", pkceChallenge(args.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

function isCustomOAuthConnector(
  connector: CustomConnectorRow,
): connector is CustomConnectorRow & {
  readonly authMode: "oauth";
  readonly oauthConfig: CustomConnectorOAuthConfigRow;
} {
  return connector.authMode === "oauth" && connector.oauthConfig !== null;
}

function isAutomaticOAuthConnector(
  connector: CustomConnectorRow,
): connector is CustomConnectorRow & {
  readonly kind: "mcp";
  readonly authMode: "automatic";
  readonly oauthConfig: null;
} {
  return (
    connector.kind === "mcp" &&
    connector.authMode === "automatic" &&
    connector.oauthConfig === null
  );
}

interface AutomaticOAuthClientPresentation {
  readonly redirectUri: string;
  readonly cimdClientId: string;
  readonly dcrClientMetadata: OAuthClientMetadata;
}

interface StartCustomConnectorOAuth2Args {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly redirectUri: string;
  readonly automaticOAuthClient?: AutomaticOAuthClientPresentation;
  readonly agentId?: string;
  readonly account: ConnectorAccountMutationIntent;
  readonly feishuContext?: {
    readonly installationId?: string;
    readonly expectedOpenId?: string;
  };
}

type PreparedOAuthStart = {
  readonly redirectUri: string;
  readonly state: string;
  readonly authorizationUrl: string;
  readonly codeVerifier: string | null;
  readonly oauthRequestedScopes: string | null;
} & (
  | {
      readonly authMode: "oauth";
      readonly context: CustomConnectorCustomOAuthStateContext;
    }
  | {
      readonly authMode: "automatic";
      readonly context: PreparedCustomConnectorAutomaticOAuthStateContext;
    }
);

function connectorConnectionMutationFailure(
  resolution: Exclude<ConnectorConnectionMutationResolution, { kind: "ready" }>,
) {
  return resolution.kind === "missing"
    ? notFound("Connector account not found")
    : conflict(
        resolution.kind === "ambiguous"
          ? "Multiple connector accounts require an exact choice"
          : "This connector does not support additional accounts",
      );
}

function prepareCustomOAuthStart(
  connector: CustomConnectorRow & {
    readonly authMode: "oauth";
    readonly oauthConfig: CustomConnectorOAuthConfigRow;
  },
  args: StartCustomConnectorOAuth2Args,
): PreparedOAuthStart {
  const state = generateConnectorOAuthState();
  const codeVerifier =
    connector.oauthConfig.pkceMethod === "S256" ? createPkceVerifier() : null;
  return {
    authMode: "oauth",
    redirectUri: args.redirectUri,
    state,
    authorizationUrl: buildCustomConnectorOAuth2AuthorizationUrl({
      config: connector.oauthConfig,
      redirectUri: args.redirectUri,
      state,
      codeVerifier,
    }),
    codeVerifier,
    oauthRequestedScopes: null,
    context: {
      version: 2,
      authMode: "oauth",
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      ...(connector.oauthConfig.providerAdapter === "feishu" &&
      args.feishuContext
        ? {
            providerContext: {
              provider: "feishu" as const,
              completionTarget: "feishu" as const,
              ...(args.feishuContext.installationId
                ? { installationId: args.feishuContext.installationId }
                : {}),
              ...(args.feishuContext.expectedOpenId
                ? { expectedOpenId: args.feishuContext.expectedOpenId }
                : {}),
            },
          }
        : {}),
    },
  };
}

const readAutomaticOAuthStartPreflight$ = command(
  async (
    { get },
    args: Pick<
      StartCustomConnectorOAuth2Args,
      "orgId" | "userId" | "account"
    > & {
      readonly connectorId: string;
      readonly storageVersion: number;
    },
  ) => {
    const db = get(db$);
    const [definition] = await db
      .select({
        authMode: orgCustomConnectors.authMode,
        storageVersion: orgCustomConnectors.storageVersion,
        providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .for("update", { of: orgCustomConnectors })
      .limit(1);
    if (
      !definition ||
      definition.authMode !== "automatic" ||
      definition.storageVersion !== args.storageVersion
    ) {
      throw new Error(
        "Custom connector credential contract changed during OAuth connection",
      );
    }
    // The definition lock ends with its statement. Keep the account probe
    // separate so its snapshot follows any wait on that definition row.
    if (args.account.intent === "reconnect") {
      const [existing] = await db
        .select(existingConnectorConnectionSelection())
        .from(connectors)
        .where(
          and(
            eq(connectors.id, args.account.connectionId),
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.customConnectorId, args.connectorId),
          ),
        )
        .limit(1);
      return existing
        ? { kind: "ready" as const }
        : { kind: "missing" as const };
    }
    // Add allows siblings and has no external-ID match. Still execute the
    // original bounded read and decode every selected field before proceeding.
    await db
      .select(existingConnectorConnectionSelection())
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.customConnectorId, args.connectorId),
        ),
      )
      .orderBy(connectors.id)
      .limit(2);
    return { kind: "ready" as const };
  },
);

const prepareAutomaticOAuthStart$ = command(
  async (
    { set },
    context: {
      readonly connector: CustomConnectorRow & {
        readonly kind: "mcp";
        readonly authMode: "automatic";
        readonly oauthConfig: null;
      };
      readonly args: StartCustomConnectorOAuth2Args;
      readonly featureContext: FeatureSwitchContext;
      readonly client: AutomaticOAuthClientPresentation;
    },
    signal: AbortSignal,
  ) => {
    const { connector, args, featureContext, client } = context;
    // Finish both reads before checking cancellation, as the former preflight did.
    const preflight = await set(readAutomaticOAuthStartPreflight$, {
      orgId: args.orgId,
      userId: args.userId,
      account: args.account,
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
    });
    signal.throwIfAborted();
    if (preflight.kind !== "ready") {
      return {
        ok: false as const,
        response: connectorConnectionMutationFailure(preflight),
      };
    }
    const state = generateConnectorOAuthState();
    const automatic = await settle(
      set(
        prepareCustomConnectorAutomaticOAuthAuthorization$,
        {
          orgId: args.orgId,
          customConnectorId: connector.id,
          storageVersion: connector.storageVersion,
          endpoint: connector.endpoint,
          redirectUri: client.redirectUri,
          state,
          cimdClientId: client.cimdClientId,
          dcrClientMetadata: client.dcrClientMetadata,
          featureContext,
        },
        signal,
      ),
      signal,
    );
    if (!automatic.ok) {
      const error = automatic.error;
      if (!(error instanceof McpAutomaticOAuthError)) {
        throw error;
      }
      const code = customConnectorAutomaticOAuthErrorCode(error);
      const response =
        error.kind === "temporary"
          ? {
              status: 502 as const,
              body: {
                error: {
                  code,
                  message:
                    "The MCP OAuth provider is temporarily unavailable. Try again later.",
                },
              },
            }
          : {
              status: 400 as const,
              body: {
                error: {
                  code,
                  message:
                    "Automatic MCP OAuth setup failed. Check the server's OAuth configuration or choose another authentication method.",
                },
              },
            };
      return { ok: false as const, response };
    }
    const prepared = automatic.value;
    if (prepared.kind === "none") {
      return { ok: true as const, result: prepared };
    }
    return {
      ok: true as const,
      result: {
        kind: "oauth" as const,
        prepared: {
          authMode: "automatic",
          redirectUri: client.redirectUri,
          state,
          authorizationUrl: prepared.authorizationUrl,
          codeVerifier: prepared.codeVerifier,
          oauthRequestedScopes: prepared.requestedScope,
          context:
            prepared.context satisfies PreparedCustomConnectorAutomaticOAuthStateContext,
        } satisfies PreparedOAuthStart,
      },
    };
  },
);

interface CustomConnectorOAuthStartPersistenceArgs {
  readonly connector: CustomConnectorRow;
  readonly args: StartCustomConnectorOAuth2Args;
  readonly prepared: PreparedOAuthStart;
}

const persistCustomConnectorOAuthStart$ = command(
  async function persistCustomConnectorOAuthStart(
    { set },
    context: CustomConnectorOAuthStartPersistenceArgs,
    signal: AbortSignal,
  ) {
    const db = set(writeDb$);
    const { connector, args, prepared } = context;
    const expiresAt = connectorOAuthStateExpiresAt();
    const allowSiblings = !isIntegrationManagedCustomConnector(connector);
    const query = customConnectorOAuthStartSql({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      authMode: prepared.authMode,
      allowSiblings,
      account: args.account,
      state: prepared.state,
      agentId: args.agentId,
      redirectUri: prepared.redirectUri,
      authorizationUrl: prepared.authorizationUrl,
      oauthRequestedScopes: prepared.oauthRequestedScopes,
      codeVerifier: prepared.codeVerifier,
      oauthContext: JSON.stringify(prepared.context),
      expiresAt,
    });
    signal.throwIfAborted();
    const [result] = parseRawRows(
      customConnectorOAuthStartResultSchema,
      await db.execute(query),
    );
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Failed to create connector OAuth state");
    }
    if (!result.contractValid) {
      throw new Error(
        "Custom connector credential contract changed during OAuth connection",
      );
    }
    if (args.account.intent === "reconnect" && !result.accountPresent) {
      return { kind: "missing" as const };
    }
    if (
      args.account.intent !== "reconnect" &&
      !allowSiblings &&
      result.accountPresent
    ) {
      return { kind: "sibling-disabled" as const };
    }
    return customConnectorOAuthStartFromRow(
      result.oauthStateId === null ? undefined : { id: result.oauthStateId },
      args.account,
      expiresAt,
    );
  },
);

function automaticNoAuthAgentAuthorizationFailure(
  authorization: AddUserCustomConnectorResult,
): ReturnType<typeof badRequestMessage> | null {
  switch (authorization.status) {
    case "added": {
      return null;
    }
    case "agentNotFound": {
      return badRequestMessage(
        "Authentication connected, but the requested agent was not found",
      );
    }
    case "customConnectorsNotFound": {
      return badRequestMessage(
        "Authentication connected, but the custom connector was not found",
      );
    }
    case "customConnectorPermissionSelectionRequired": {
      return badRequestMessage(
        "Authentication connected, but connector permissions must be selected before authorizing the agent",
      );
    }
    case "invalidCustomConnectorPermissions": {
      return badRequestMessage(
        `Authentication connected, but agent authorization failed: ${authorization.message}`,
      );
    }
  }
}

type AutomaticNoAuthConnector = CustomConnectorRow & {
  readonly kind: "mcp";
  readonly authMode: "automatic";
  readonly oauthConfig: null;
};

interface AutomaticNoAuthPersistenceContext {
  readonly connector: AutomaticNoAuthConnector;
  readonly args: StartCustomConnectorOAuth2Args;
}

function automaticNoAuthCredentialContractRef(
  args: StartCustomConnectorOAuth2Args,
  connector: AutomaticNoAuthConnector,
) {
  return {
    orgId: args.orgId,
    connectorId: connector.id,
    storageVersion: connector.storageVersion,
    authMode: "automatic" as const,
  };
}

function noAuthWriteArgs(
  args: StartCustomConnectorOAuth2Args,
  connector: AutomaticNoAuthConnector,
  resolution: Extract<ConnectorConnectionMutationResolution, { kind: "ready" }>,
) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    authMethod: "none" as const,
    storageVersion: connector.storageVersion,
    tokenExpiresAt: null,
    target: {
      kind: "custom" as const,
      customConnectorId: connector.id,
      oauthScopes: null,
      identity: { kind: "local" as const },
    },
    resolution: resolution.mutation,
  };
}

function automaticNoAuthConnectionResponse(
  connector: AutomaticNoAuthConnector,
  connection: { readonly id: string },
) {
  return {
    result: "connected" as const,
    connector: serialiseCustomConnector({
      row: connector,
    }),
    connectionId: connection.id,
  };
}

function automaticNoAuthWakeupFailure(
  wakeup: NonNullable<ReturnType<typeof automaticNoAuthWakeup>>,
  error: unknown,
) {
  return {
    orgId: wakeup.scope.orgId,
    scopedToUser: wakeup.scope.userId !== undefined,
    scopedToAgent: wakeup.scope.agentId !== undefined,
    targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
    error,
  };
}

const automaticNoAuthPublicationRow = object({
  contract_current: boolean(),
  connection_id: uuid().nullable(),
});

const commitAutomaticNoAuthConnection$ = command(
  function persistAutomaticNoAuthConnection(
    { set },
    context: AutomaticNoAuthPersistenceContext,
    signal: AbortSignal,
  ) {
    const { connector, args } = context;
    const db = set(writeDb$);
    const publication = (async () => {
      const contractRef = automaticNoAuthCredentialContractRef(args, connector);
      const plan = customConnectorOAuth2CredentialContractReadPlan(contractRef);
      const definitions = await db
        .select(plan.columns)
        .from(plan.from)
        .leftJoin(plan.join.table, plan.join.on)
        .where(plan.where)
        .limit(1);
      customConnectorOAuth2CredentialContractFromRows(definitions, contractRef);
      const mutationReadArgs = automaticNoAuthMutation(args, connector);
      const resolution = await (async () => {
        let read = connectionMutationReadPlan(mutationReadArgs);
        for (;;) {
          const rows = await db
            .select(read.columns)
            .from(read.from)
            .where(read.where)
            .orderBy(...read.orderBy)
            .limit(read.limit);
          const result = connectionMutationReadResult(
            mutationReadArgs,
            read,
            rows,
          );
          if (result.kind === "resolved") {
            return result.resolution;
          }
          read = result.read;
        }
      })();
      if (resolution.kind !== "ready") {
        return { resolution, connection: null };
      }
      const statement = automaticNoAuthPublicationSql(
        noAuthWriteArgs(args, connector, resolution),
      );
      signal.throwIfAborted();
      const [row] = parseRawRows(
        automaticNoAuthPublicationRow,
        await db.execute(statement),
      );
      if (!row) {
        throw new Error("Automatic no-auth publication returned no row");
      }
      if (!row.contract_current) {
        throw new Error(
          "Custom connector credential contract changed during OAuth connection",
        );
      }
      if (row.connection_id === null) {
        return { changed: true as const };
      }
      return { resolution, connection: { id: row.connection_id } };
    })();
    return (async () => {
      const result = await publication;
      if ("changed" in result) {
        return result;
      }
      const wakeup = automaticNoAuthWakeup(args, connector, result.connection);
      if (wakeup) {
        await (async () => {
          const result = await settle(
            (async () => {
              const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
              if (targets.length === 0) {
                return;
              }
              const rows = await db
                .select(connectorRuntimeWakeupRunColumns())
                .from(agentRuns)
                .where(connectorRuntimeWakeupCondition(wakeup.scope));
              await publishConnectorRuntimeWakeupRows({
                scope: wakeup.scope,
                targets,
                rows,
              });
            })(),
          );
          if (!result.ok) {
            reportConnectorRuntimeWakeupDiscoveryFailure(
              automaticNoAuthWakeupFailure(wakeup, result.error),
            );
          }
        })();
      }
      return result;
    })();
  },
);

const persistAutomaticNoAuthConnection$ = command(
  async (
    { set },
    context: AutomaticNoAuthPersistenceContext,
    signal: AbortSignal,
  ) => {
    const { connector, args } = context;
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const result = await set(commitAutomaticNoAuthConnection$, context, signal);
    if ("changed" in result) {
      signal.throwIfAborted();
      return conflict("Connector changed while connecting; retry the request");
    }
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (result.resolution.kind !== "ready") {
      signal.throwIfAborted();
      return connectorConnectionMutationFailure(result.resolution);
    }
    if (!result.connection) {
      throw new Error("Ready connector mutation did not return a connection");
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    if (args.agentId) {
      const authorization = await set(addUserCustomConnector$, {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
        customConnectorId: connector.id,
      });
      signal.throwIfAborted();
      const authorizationFailure =
        automaticNoAuthAgentAuthorizationFailure(authorization);
      if (authorizationFailure) {
        return authorizationFailure;
      }
    }
    return automaticNoAuthConnectionResponse(connector, result.connection);
  },
);

export const startCustomConnectorOAuth2$ = command(
  async (
    { get, set },
    args: StartCustomConnectorOAuth2Args,
    signal: AbortSignal,
  ) => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      return notFound("Custom connector not found");
    }
    const customOAuth = isCustomOAuthConnector(connector);
    const automaticOAuth = isAutomaticOAuthConnector(connector);
    if (!customOAuth && !automaticOAuth) {
      return badRequestMessage(
        "Custom connector does not support OAuth 2.0 authentication",
      );
    }
    if (isIntegrationManagedCustomConnector(connector) && !args.feishuContext) {
      return integrationManagedCustomConnectorMutationForbidden();
    }
    if (automaticOAuth && !args.automaticOAuthClient) {
      return badRequestMessage(
        "Automatic OAuth client identity is unavailable",
      );
    }
    let prepared: PreparedOAuthStart;
    if (customOAuth) {
      prepared = prepareCustomOAuthStart(connector, args);
    } else if (automaticOAuth && args.automaticOAuthClient) {
      const featureContext = await get(
        userFeatureSwitchContext(args.orgId, args.userId),
      );
      signal.throwIfAborted();
      const automatic = await set(
        prepareAutomaticOAuthStart$,
        {
          connector,
          args,
          featureContext,
          client: args.automaticOAuthClient,
        },
        signal,
      );
      if (!automatic.ok) {
        return automatic.response;
      }
      if (automatic.result.kind === "none") {
        return await set(
          persistAutomaticNoAuthConnection$,
          {
            connector,
            args,
          },
          signal,
        );
      }
      prepared = automatic.result.prepared;
    } else {
      throw new Error("OAuth connector mode changed during authorization");
    }
    const mutationStart = await set(
      persistCustomConnectorOAuthStart$,
      {
        connector,
        args,
        prepared,
      },
      signal,
    );
    if (mutationStart.kind !== "ready") {
      return connectorConnectionMutationFailure(mutationStart);
    }
    return {
      result: "authorization" as const,
      authorizationUrl: prepared.authorizationUrl,
      connectionId: mutationStart.connectionId ?? undefined,
      oauthAttemptId: mutationStart.oauthAttemptId,
    };
  },
);

function automaticOAuthReauthorizationScopes(
  connection: Pick<StoredConnection, "oauthScopes">,
  challengedScopes: readonly string[],
): readonly string[] | null {
  const storedScopes = connection.oauthScopes
    ? array(mcpOAuthScopeTokenSchema)
        .max(100)
        .parse(safeJsonParse(connection.oauthScopes))
    : [];
  const parsed = mcpOAuthScopeListSchema.safeParse([
    ...new Set([...storedScopes, ...challengedScopes]),
  ]);
  return parsed.success ? parsed.data : null;
}

function automaticOAuthReauthorizationFailure(error: unknown) {
  if (!(error instanceof McpAutomaticOAuthError)) {
    throw error;
  }
  const code = customConnectorAutomaticOAuthErrorCode(error);
  return error.kind === "temporary"
    ? {
        status: 502 as const,
        body: {
          error: {
            code,
            message:
              "The MCP OAuth provider is temporarily unavailable. Try again later.",
          },
        },
      }
    : {
        status: 409 as const,
        body: {
          error: {
            code,
            message:
              "Automatic MCP OAuth authorization changed. Reconnect the account and try again.",
          },
        },
      };
}

function automaticOAuthReauthorizationUnavailable(
  target: "account" | "connector",
) {
  return conflict(
    `MCP OAuth reauthorization is unavailable for this ${target}`,
  );
}

interface AutomaticOAuthReauthorizationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly connectionId: string;
  readonly scopes: readonly string[];
}

function automaticOAuthReauthorizationStartValues(
  args: AutomaticOAuthReauthorizationArgs,
  connector: CustomConnectorRow,
  prepared: CustomConnectorAutomaticOAuthAuthorization,
  redirectUri: string,
  state: string,
): CustomConnectorOAuthStartPersistenceArgs {
  return {
    connector,
    args: {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
      redirectUri,
      account: {
        intent: "reconnect",
        connectionId: args.connectionId,
      },
    },
    prepared: {
      authMode: "automatic",
      redirectUri,
      state,
      authorizationUrl: prepared.authorizationUrl,
      codeVerifier: prepared.codeVerifier,
      oauthRequestedScopes: prepared.requestedScope,
      context: prepared.context,
    },
  };
}

export const startCustomConnectorAutomaticOAuthReauthorization$ = command(
  async (
    { get, set },
    args: AutomaticOAuthReauthorizationArgs,
    signal: AbortSignal,
  ) => {
    const connector = await get(
      getCustomConnectorById({
        orgId: args.orgId,
        connectorId: args.connectorId,
      }),
    );
    signal.throwIfAborted();
    if (!connector || !isAutomaticOAuthConnector(connector)) {
      return automaticOAuthReauthorizationUnavailable("connector");
    }
    const featureContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const connectionIdentity: CustomConnectorOAuthConnectionReadIdentity = {
      orgId: args.orgId,
      userId: args.userId,
      customConnectorId: connector.id,
      memberConnectorId: args.connectionId,
      storageVersion: connector.storageVersion,
      definitionAuthMode: "automatic",
    };
    const connection = await (async (): Promise<StoredConnection | null> => {
      const plan = customConnectorOAuthConnectionReadPlan(connectionIdentity);
      const query = db
        .select(plan.columns)
        .from(connectors)
        .where(plan.condition);
      const rows = await query.limit(1);
      const connection = rows[0];
      if (!connection) {
        return null;
      }
      // Re-check the complete identity at the secret read boundary because the
      // organization definition can change after the parent lookup.
      const tokenPlan = customConnectorOAuthConnectionTokenReadPlan(
        connectionIdentity,
        connection.id,
      );
      const tokenRows = await db
        .select(tokenPlan.columns)
        .from(secrets)
        .innerJoin(connectors, tokenPlan.accountJoin)
        .innerJoin(orgCustomConnectors, tokenPlan.definitionJoin)
        .where(tokenPlan.condition);
      return storedConnectionFromRows(connection, tokenRows);
    })();
    signal.throwIfAborted();
    if (
      !connection ||
      connection.needsReconnect ||
      !connection.encryptedAccessToken ||
      !connectionAccessTokenIsCurrent(connection)
    ) {
      return automaticOAuthReauthorizationUnavailable("account");
    }
    const binding = await (async () => {
      const plan = customConnectorAutomaticOAuthBindingReadPlan(connection.id);
      const [row] = await db
        .select(plan.columns)
        .from(customConnectorAccountOauthBindings)
        .innerJoin(connectors, plan.accountJoin)
        .innerJoin(orgCustomConnectors, plan.connectorJoin)
        .leftJoin(orgCustomConnectorDcrRegistrations, plan.registrationJoin)
        .where(plan.condition)
        .limit(1);
      return customConnectorAutomaticOAuthBindingFromRow(row);
    })();
    signal.throwIfAborted();
    if (!binding || binding.customConnectorId !== connector.id) {
      return automaticOAuthReauthorizationUnavailable("account");
    }
    const scopes = automaticOAuthReauthorizationScopes(connection, args.scopes);
    if (!scopes) {
      return badRequestMessage("MCP OAuth scope request is too large");
    }
    const clientMetadata = configuredOkouMcpOAuthClientMetadata();
    const [redirectUri] = clientMetadata.redirect_uris;
    if (!redirectUri) {
      throw new Error("Okou MCP OAuth callback is unavailable");
    }
    const state = generateConnectorOAuthState();
    const preparedResult = await settle(
      set(
        prepareCustomConnectorAutomaticOAuthReauthorization$,
        {
          binding,
          storageVersion: connector.storageVersion,
          endpoint: connector.endpoint,
          redirectUri,
          cimdClientId: clientMetadata.client_id,
          requestedScope: scopes.join(" "),
          state,
          featureContext,
        },
        signal,
      ),
      signal,
    );
    if (!preparedResult.ok) {
      return automaticOAuthReauthorizationFailure(preparedResult.error);
    }
    const prepared = preparedResult.value;
    const persisted = await set(
      persistCustomConnectorOAuthStart$,
      automaticOAuthReauthorizationStartValues(
        args,
        connector,
        prepared,
        redirectUri,
        state,
      ),
      signal,
    );
    if (persisted.kind !== "ready") {
      return automaticOAuthReauthorizationUnavailable("account");
    }
    return {
      authorizationUrl: prepared.authorizationUrl,
      expiresAt: persisted.expiresAt.toISOString(),
    };
  },
);

export function parseCustomConnectorOAuthStateContext(
  raw: string | null,
): CustomConnectorOAuthStateContext | null {
  if (!raw) {
    return null;
  }
  const parsed = customConnectorOAuthStateContextSchema.safeParse(
    safeJsonParse(raw),
  );
  return parsed.success ? parsed.data : null;
}

export function parseValidCustomConnectorOAuthState(
  storedState: StoredCustomConnectorOAuthState,
): CustomConnectorOAuthStateContext | null {
  const context = parseCustomConnectorOAuthStateContext(
    storedState.oauthContext,
  );
  if (
    !context ||
    storedState.customConnectorId !== context.connectorId ||
    storedState.storageVersion !== context.storageVersion
  ) {
    return null;
  }
  return context;
}

export function customConnectorOAuthStateMatchesDefinition(
  context: CustomConnectorOAuthStateContext,
  connector: Pick<CustomConnectorRow, "id" | "storageVersion">,
): boolean {
  return (
    connector.id === context.connectorId &&
    connector.storageVersion === context.storageVersion
  );
}

export async function decryptCustomConnectorOAuth2Credentials(
  connector: Pick<CustomConnectorRow, "oauthConfig">,
  featureContext: FeatureSwitchContext,
): Promise<OAuthClientCredentials | null> {
  if (!connector.oauthConfig) {
    return null;
  }
  return {
    clientId: connector.oauthConfig.clientId,
    clientSecret: await decryptStoredSecretValue(
      connector.oauthConfig.encryptedClientSecret,
      featureContext,
    ),
  };
}

export async function encryptTokenValues(args: {
  readonly token: CustomConnectorOAuthTokenResult;
  readonly fallbackRefreshToken?: string;
  readonly fallbackEncryptedIdToken?: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
}> {
  const refreshToken = args.token.refreshToken ?? args.fallbackRefreshToken;
  const [accessToken, encryptedRefreshToken, encryptedIdToken] =
    await Promise.all([
      encryptStoredSecretValue(args.token.accessToken, args.featureContext),
      refreshToken
        ? encryptStoredSecretValue(refreshToken, args.featureContext)
        : Promise.resolve(null),
      args.token.idToken
        ? encryptStoredSecretValue(args.token.idToken, args.featureContext)
        : Promise.resolve(args.fallbackEncryptedIdToken ?? null),
    ]);
  return {
    accessToken,
    refreshToken: encryptedRefreshToken,
    idToken: encryptedIdToken,
  };
}

export function connectionTokenRows(args: {
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly encrypted: Awaited<ReturnType<typeof encryptTokenValues>>;
}): (typeof secrets.$inferInsert)[] {
  return [
    {
      name: CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
      encryptedValue: args.encrypted.accessToken,
      type: "connector",
      connectorId: args.connectionId,
      userId: args.userId,
      orgId: args.orgId,
    },
    ...(args.encrypted.refreshToken
      ? [
          {
            name: CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
            encryptedValue: args.encrypted.refreshToken,
            type: "connector" as const,
            connectorId: args.connectionId,
            userId: args.userId,
            orgId: args.orgId,
          },
        ]
      : []),
    ...(args.encrypted.idToken
      ? [
          {
            name: CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME,
            encryptedValue: args.encrypted.idToken,
            type: "connector" as const,
            connectorId: args.connectionId,
            userId: args.userId,
            orgId: args.orgId,
          },
        ]
      : []),
  ];
}

const replaceConnectionTokens$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly storedIdentity: StoredConnection;
      readonly token: CustomConnectorOAuthTokenResult;
      readonly fallbackRefreshToken?: string;
      readonly fallbackEncryptedIdToken?: string;
      readonly featureContext: FeatureSwitchContext;
    },
  ): Promise<
    | { readonly kind: "replaced"; readonly encryptedAccessToken: string }
    | { readonly kind: "publication-lost" }
  > => {
    const identity = resolveRefreshedOAuthIdentity(
      args.storedIdentity,
      args.token.userInfo,
    );
    const encrypted = await encryptTokenValues(args);
    const db = set(writeDb$);
    const claimed = db.$with("claimed_custom_oauth_refresh").as(
      db
        .update(connectors)
        .set({
          tokenExpiresAt: args.token.expiresAt,
          needsReconnect: false,
          reconnectReason: null,
          ...(args.token.scopes === null
            ? {}
            : { oauthScopes: JSON.stringify(args.token.scopes) }),
          ...(identity.kind === "update"
            ? {
                externalId: identity.externalId,
                externalUsername: identity.externalUsername,
                externalEmail: identity.externalEmail,
              }
            : {}),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(connectors.id, args.connectionId),
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            storedRefreshTokenCondition(
              args.connectionId,
              args.storedIdentity.encryptedRefreshToken,
              CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
            ),
          ),
        )
        .returning({ id: connectors.id }),
    );
    const removed = db.$with("removed_custom_oauth_secrets").as(
      db
        .delete(secrets)
        .where(
          inArray(
            secrets.connectorId,
            db.select({ id: claimed.id }).from(claimed),
          ),
        )
        .returning({ id: secrets.id }),
    );
    const tokenRows = connectionTokenRows({ ...args, encrypted });
    const values = sql.join(
      tokenRows.map((row) => {
        return sql`(${row.name}, ${row.encryptedValue})`;
      }),
      sql`, `,
    );
    // Keep database defaults for secret IDs/timestamps. Exhaust deletion before
    // inserting the replacement names, and gate every credential on the CAS winner.
    const inserted = db.$with("inserted_custom_oauth_secrets", {
      id: secrets.id,
    }).as(sql`INSERT INTO ${secrets}
      (name, encrypted_value, type, connector_id, user_id, org_id)
    SELECT token.name, token.encrypted_value, 'connector', ${claimed.id},
      ${args.userId}, ${args.orgId}
    FROM ${claimed}
    CROSS JOIN (VALUES ${values}) AS token(name, encrypted_value)
    WHERE ${gte(db.select({ count: count() }).from(removed), 0)}
    RETURNING id`);
    const [published] = await db
      .with(claimed, removed, inserted)
      .select({ id: claimed.id })
      .from(claimed)
      .where(gte(db.select({ count: count() }).from(inserted), 0));
    return published
      ? { kind: "replaced", encryptedAccessToken: encrypted.accessToken }
      : { kind: "publication-lost" };
  },
);

export function customConnectorOAuth2CredentialContractReadPlan(args: {
  readonly orgId: string;
  readonly connectorId: string;
}) {
  return {
    columns: {
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    },
    from: orgCustomConnectors,
    join: {
      table: orgCustomConnectorOauthConfigs,
      on: and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    },
    where: and(
      eq(orgCustomConnectors.id, args.connectorId),
      eq(orgCustomConnectors.orgId, args.orgId),
    ),
  };
}

export function customConnectorOAuth2CredentialContractFromRows(
  rows: readonly {
    readonly authMode: CustomConnectorRow["authMode"];
    readonly storageVersion: number;
    readonly providerAdapter: CustomConnectorOAuthProviderAdapter | null;
  }[],
  args: {
    readonly storageVersion: number;
    readonly authMode: "oauth" | "automatic";
  },
): { readonly providerAdapter: CustomConnectorOAuthProviderAdapter | null } {
  const [definition] = rows;
  if (
    !definition ||
    definition.authMode !== args.authMode ||
    definition.storageVersion !== args.storageVersion
  ) {
    throw new Error(
      "Custom connector credential contract changed during OAuth connection",
    );
  }
  return { providerAdapter: definition.providerAdapter };
}

function customOAuthConnectionTarget(
  connectorId: string,
  token: CustomConnectorOAuthTokenResult,
) {
  return {
    kind: "custom" as const,
    customConnectorId: connectorId,
    oauthScopes: token.scopes,
    identity: token.userInfo
      ? {
          kind: "external" as const,
          externalId: token.userInfo.id,
          externalUsername: token.userInfo.username,
          externalEmail: token.userInfo.email,
        }
      : { kind: "local" as const },
  };
}

interface StoreCustomConnectorOAuth2ConnectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly token: CustomConnectorOAuthTokenResult;
  readonly featureContext: FeatureSwitchContext;
  readonly account: ConnectorAccountMutationIntent;
  readonly insertConnectionId?: string;
  readonly automaticOAuthBinding?: {
    readonly issuer: string;
    readonly resource: string;
    readonly resourceMetadataUrl: string | null;
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly tokenEndpointAuthMethod:
      "none" | "client_secret_basic" | "client_secret_post";
    readonly registrationMethod: "cimd" | "dcr";
    readonly dcrRegistrationId: string | null;
  };
}

function customOAuth2CredentialContractRef(
  args: Pick<
    StoreCustomConnectorOAuth2ConnectionArgs,
    "orgId" | "connectorId" | "storageVersion" | "automaticOAuthBinding"
  >,
) {
  return {
    orgId: args.orgId,
    connectorId: args.connectorId,
    storageVersion: args.storageVersion,
    authMode: args.automaticOAuthBinding
      ? ("automatic" as const)
      : ("oauth" as const),
  };
}

function customOAuthConnectionMutationValues(
  args: Pick<
    StoreCustomConnectorOAuth2ConnectionArgs,
    "orgId" | "userId" | "connectorId" | "account"
  >,
  contract: ReturnType<typeof customConnectorOAuth2CredentialContractFromRows>,
): ConnectorConnectionMutationArgs {
  return {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "custom", customConnectorId: args.connectorId },
    mutation: args.account,
    allowSiblings: !isIntegrationManagedCustomConnectorProviderAdapter(
      contract.providerAdapter,
    ),
  };
}

function customOAuthTokenRows(
  args: StoreCustomConnectorOAuth2ConnectionArgs,
  connectionId: string,
  encrypted: Awaited<ReturnType<typeof encryptTokenValues>>,
) {
  return connectionTokenRows({ ...args, connectionId, encrypted });
}

type StoreCustomConnectorOAuth2ConnectionResult =
  | { readonly kind: "stored"; readonly connectionId: string }
  | { readonly kind: "missing" | "ambiguous" | "sibling-disabled" };

const customOAuthPublicationRow = object({
  connection_id: uuid().nullable(),
  complete: literal(1),
}).strict();

export const storeCustomConnectorOAuth2Connection$ = command(
  async function storeCustomConnectorOAuth2Connection(
    { set },
    args: StoreCustomConnectorOAuth2ConnectionArgs,
    signal: AbortSignal,
  ): Promise<StoreCustomConnectorOAuth2ConnectionResult> {
    const db = set(writeDb$);
    const encrypted = await encryptTokenValues(args);
    signal.throwIfAborted();
    const contractRef = customOAuth2CredentialContractRef(args);
    const plan = customConnectorOAuth2CredentialContractReadPlan(contractRef);
    const contract = customConnectorOAuth2CredentialContractFromRows(
      await db
        .select(plan.columns)
        .from(plan.from)
        .leftJoin(plan.join.table, plan.join.on)
        .where(plan.where)
        .limit(1),
      contractRef,
    );
    signal.throwIfAborted();
    const mutationReadArgs = customOAuthConnectionMutationValues(
      args,
      contract,
    );
    const revisions = new Map<string, string>();
    const resolution = await (async () => {
      let read = connectionMutationReadPlan(mutationReadArgs);
      for (;;) {
        const rows = await db
          .select({
            ...read.columns,
            publicationRevision: sql`${connectors}.xmin::text`.mapWith(
              pgTextDecoder,
            ),
          })
          .from(read.from)
          .where(read.where)
          .orderBy(...read.orderBy)
          .limit(read.limit);
        signal.throwIfAborted();
        for (const row of rows) {
          revisions.set(row.id, row.publicationRevision);
        }
        const result = connectionMutationReadResult(
          mutationReadArgs,
          read,
          rows,
        );
        if (result.kind === "resolved") {
          return result.resolution;
        }
        read = result.read;
      }
    })();
    signal.throwIfAborted();
    const metadata =
      resolution.kind === "ready"
        ? customOAuthWriteArgs(args, resolution)
        : null;
    const accountRevision =
      metadata?.resolution.kind === "update"
        ? revisions.get(metadata.resolution.existing.id)
        : null;
    if (accountRevision === undefined) {
      throw new Error(
        "Custom OAuth reconnect has no observed account revision",
      );
    }
    const query = customOAuthConnectionPublicationSql({
      ...contractRef,
      providerAdapter: contract.providerAdapter,
      account: metadata === null ? null : { metadata, accountRevision },
      // The statement replaces this descriptor's ID with its actual winning account.
      tokens: customOAuthTokenRows(
        args,
        "00000000-0000-4000-8000-000000000000",
        encrypted,
      ),
      binding: args.automaticOAuthBinding
        ? { customConnectorId: args.connectorId, ...args.automaticOAuthBinding }
        : null,
      quest: customOAuthQuest(args),
    });
    signal.throwIfAborted();
    // Finish the admitted publication before the caller observes post-commit abort.
    return await (async () => {
      const result = await settle(
        (async () => {
          return parseRawRows(
            customOAuthPublicationRow,
            await db.execute(query),
          );
        })(),
      );
      if (!result.ok) {
        if (safeSqlStateCode(result.error) === "22012") {
          throw new Error(
            "Custom connector account or credential contract changed while connecting; submit the connection again",
            { cause: result.error },
          );
        }
        throw result.error;
      }
      const [published] = result.value;
      if (result.value.length !== 1 || !published) {
        throw new Error("Custom OAuth publication returned an invalid result");
      }
      if (resolution.kind !== "ready") {
        return resolution;
      }
      if (published.connection_id === null) {
        throw new Error("Custom OAuth publication did not return its account");
      }
      return { kind: "stored", connectionId: published.connection_id };
    })();
  },
);

interface StoredConnection {
  readonly id: string;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly oauthScopes: string | null;
  readonly externalId: string | null;
  readonly externalUsername: string | null;
  readonly externalEmail: string | null;
  readonly encryptedAccessToken: string | null;
  readonly encryptedRefreshToken: string | null;
  readonly encryptedIdToken: string | null;
}

function storedConnectionFromRows(
  connection: Omit<
    StoredConnection,
    "encryptedAccessToken" | "encryptedRefreshToken" | "encryptedIdToken"
  >,
  tokenRows: readonly {
    readonly secretName: string;
    readonly encryptedValue: (typeof secrets.$inferSelect)["encryptedValue"];
  }[],
): StoredConnection {
  return {
    id: connection.id,
    tokenExpiresAt: connection.tokenExpiresAt,
    needsReconnect: connection.needsReconnect,
    oauthScopes: connection.oauthScopes,
    externalId: connection.externalId,
    externalUsername: connection.externalUsername,
    externalEmail: connection.externalEmail,
    encryptedAccessToken:
      tokenRows.find((row) => {
        return (
          row.secretName === CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME
        );
      })?.encryptedValue ?? null,
    encryptedRefreshToken:
      tokenRows.find((row) => {
        return (
          row.secretName === CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME
        );
      })?.encryptedValue ?? null,
    encryptedIdToken:
      tokenRows.find((row) => {
        return row.secretName === CUSTOM_CONNECTOR_OAUTH_ID_TOKEN_SECRET_NAME;
      })?.encryptedValue ?? null,
  };
}

function connectionAccessTokenIsCurrent(connection: StoredConnection): boolean {
  const refreshLeewayMs = connection.encryptedRefreshToken
    ? TOKEN_REFRESH_LEEWAY_MS
    : 0;
  return (
    !connection.tokenExpiresAt ||
    connection.tokenExpiresAt.getTime() > nowDate().getTime() + refreshLeewayMs
  );
}

interface AvailableCustomConnectorOAuth2AccessToken {
  readonly kind: "available";
  readonly encryptedAccessToken: string;
  readonly tokenExpiresAt: Date | null;
  readonly status: "current" | "refreshed";
}

type CustomConnectorOAuth2AccessTokenResolution =
  | AvailableCustomConnectorOAuth2AccessToken
  | { readonly kind: "unavailable" }
  | { readonly kind: "reconnect-required" };

function storedConnectionAccessToken(
  connection: StoredConnection,
):
  AvailableCustomConnectorOAuth2AccessToken | { readonly kind: "unavailable" } {
  if (!connection.encryptedAccessToken) {
    return { kind: "unavailable" };
  }
  return {
    kind: "available",
    encryptedAccessToken: connection.encryptedAccessToken,
    tokenExpiresAt: connection.tokenExpiresAt,
    status: "current",
  };
}

export class CustomConnectorOAuth2TokenRefreshError extends Error {
  constructor(cause: unknown) {
    super("Custom connector OAuth 2.0 token refresh failed", { cause });
    this.name = "CustomConnectorOAuth2TokenRefreshError";
  }
}

function refreshedConnectionTokenResult(
  replacement:
    | { readonly kind: "replaced"; readonly encryptedAccessToken: string }
    | { readonly kind: "publication-lost" },
  tokenExpiresAt: Date | null,
  signal: AbortSignal,
):
  | CustomConnectorOAuth2AccessTokenResolution
  | { readonly kind: "publication-lost" } {
  if (replacement.kind === "publication-lost") {
    return replacement;
  }
  signal.throwIfAborted();
  return {
    kind: "available",
    encryptedAccessToken: replacement.encryptedAccessToken,
    tokenExpiresAt: tokenExpiresAt,
    status: "refreshed",
  };
}

const storeRefreshedConnectionTokens$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connection: StoredConnection;
      readonly token: CustomConnectorOAuthTokenResult;
      readonly fallbackRefreshToken: string;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<
    | CustomConnectorOAuth2AccessTokenResolution
    | { readonly kind: "publication-lost" }
  > => {
    return refreshedConnectionTokenResult(
      await set(replaceConnectionTokens$, {
        connectionId: args.connection.id,
        orgId: args.orgId,
        userId: args.userId,
        storedIdentity: args.connection,
        token: args.token,
        fallbackRefreshToken: args.fallbackRefreshToken,
        fallbackEncryptedIdToken: args.connection.encryptedIdToken ?? undefined,
        featureContext: args.featureContext,
      }),
      args.token.expiresAt,
      signal,
    );
  },
);

interface ResolveCustomConnectorOAuth2AccessTokenArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorRow;
  readonly memberConnectorId: string;
  readonly featureContext: FeatureSwitchContext;
  readonly forceRefresh?: boolean;
}

/**
 * A concurrent refresh or reconnect won publication. Serve its credential when
 * usable; otherwise report the credential unavailable for this request.
 */
function currentAfterLostPublication(
  current: StoredConnection | null,
): CustomConnectorOAuth2AccessTokenResolution {
  if (!current || current.needsReconnect) {
    return { kind: "unavailable" };
  }
  const accessToken = storedConnectionAccessToken(current);
  return accessToken.kind === "available" &&
    connectionAccessTokenIsCurrent(current)
    ? accessToken
    : { kind: "unavailable" };
}

const loadCustomOAuthConnection$ = command(
  async (
    { get },
    args: ResolveCustomConnectorOAuth2AccessTokenArgs,
  ): Promise<StoredConnection | null> => {
    const connectionDb = get(db$);
    const connectionIdentity: CustomConnectorOAuthConnectionReadIdentity = {
      orgId: args.orgId,
      userId: args.userId,
      customConnectorId: args.connector.id,
      memberConnectorId: args.memberConnectorId,
      storageVersion: args.connector.storageVersion,
      definitionAuthMode: "oauth",
    };
    return await (async (): Promise<StoredConnection | null> => {
      const plan = customConnectorOAuthConnectionReadPlan(connectionIdentity);
      const query = connectionDb
        .select(plan.columns)
        .from(connectors)
        .where(plan.condition);
      const rows = await query.limit(1);
      const connection = rows[0];
      if (!connection) {
        return null;
      }
      // Re-check the complete identity at the secret read boundary because the
      // organization definition can change after the parent lookup.
      const tokenPlan = customConnectorOAuthConnectionTokenReadPlan(
        connectionIdentity,
        connection.id,
      );
      const tokenRows = await connectionDb
        .select(tokenPlan.columns)
        .from(secrets)
        .innerJoin(connectors, tokenPlan.accountJoin)
        .innerJoin(orgCustomConnectors, tokenPlan.definitionJoin)
        .where(tokenPlan.condition);
      return storedConnectionFromRows(connection, tokenRows);
    })();
  },
);

const markCustomOAuthRefreshReconnect$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly observedEncryptedRefreshToken: string | null;
      readonly reason:
        "missing_refresh_token" | "authorization_expired_or_revoked";
    },
  ): Promise<{ readonly kind: "reconnect-required" }> => {
    const reconnectDb = set(writeDb$);
    const reconnectConnectorId = args.connectionId;
    const reconnectReason = args.reason;
    const reconnectObservedToken = args.observedEncryptedRefreshToken;
    await (async () => {
      await reconnectDb
        .update(connectors)
        .set({ needsReconnect: true, reconnectReason, updatedAt: nowDate() })
        .where(
          customConnectorRefreshReconnectCondition(
            reconnectConnectorId,
            reconnectObservedToken,
            CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
          ),
        );
    })();
    return { kind: "reconnect-required" };
  },
);
const retireAutomaticOAuthRefreshRegistration$ = command(
  async (
    { set },
    registrationId: string,
  ): Promise<{ readonly kind: "reconnect-required" }> => {
    const db = set(writeDb$);
    await db.execute(
      retireCustomConnectorDcrRegistrationSql(registrationId, nowDate()),
    );
    return { kind: "reconnect-required" };
  },
);
const requestCustomOAuthTokenRefresh$ = command(
  async (
    _,
    args: Parameters<typeof refreshCustomConnectorOAuth2Token>[0],
    signal: AbortSignal,
  ) => {
    return await settle(refreshCustomConnectorOAuth2Token(args, signal));
  },
);

const resolveCustomConnectorOAuth2AccessToken$ = command(
  async (
    { set },
    args: ResolveCustomConnectorOAuth2AccessTokenArgs,
    signal: AbortSignal,
  ): Promise<CustomConnectorOAuth2AccessTokenResolution> => {
    if (args.connector.authMode !== "oauth" || !args.connector.oauthConfig) {
      return { kind: "unavailable" };
    }
    const oauthConfig = args.connector.oauthConfig;
    const connection = await set(loadCustomOAuthConnection$, args);
    signal.throwIfAborted();
    if (!connection) {
      return { kind: "unavailable" };
    }
    const accessToken = storedConnectionAccessToken(connection);
    if (
      !args.forceRefresh &&
      !connection.needsReconnect &&
      accessToken.kind === "available" &&
      connectionAccessTokenIsCurrent(connection)
    ) {
      return accessToken;
    }
    // Ordinary refresh: KMS and provider HTTP run outside any transaction and
    // publication compares the consumed refresh token (see replaceConnectionTokens).
    if (!connection.encryptedRefreshToken) {
      return await set(markCustomOAuthRefreshReconnect$, {
        connectionId: connection.id,
        observedEncryptedRefreshToken: null,
        reason: "missing_refresh_token",
      });
    }
    const [credentials, refreshToken] = await Promise.all([
      decryptCustomConnectorOAuth2Credentials(
        args.connector,
        args.featureContext,
      ),
      decryptStoredSecretValue(
        connection.encryptedRefreshToken,
        args.featureContext,
      ),
    ]);
    signal.throwIfAborted();
    if (!credentials) {
      return { kind: "unavailable" };
    }
    const refreshResult = await set(
      requestCustomOAuthTokenRefresh$,
      {
        config: oauthConfig,
        clientSecret: credentials.clientSecret,
        refreshToken,
      },
      signal,
    );
    if (!refreshResult.ok) {
      if (
        !isOAuthProviderHttpError(refreshResult.error) ||
        refreshResult.error.oauthError !== "invalid_grant"
      ) {
        throw new CustomConnectorOAuth2TokenRefreshError(refreshResult.error);
      }
      return await set(markCustomOAuthRefreshReconnect$, {
        connectionId: connection.id,
        observedEncryptedRefreshToken: connection.encryptedRefreshToken,
        reason: "authorization_expired_or_revoked",
      });
    }
    signal.throwIfAborted();
    const stored = await set(
      storeRefreshedConnectionTokens$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connection,
        token: refreshResult.value,
        fallbackRefreshToken: refreshToken,
        featureContext: args.featureContext,
      },
      signal,
    );
    if (stored.kind !== "publication-lost") {
      return stored;
    }
    const current = await set(loadCustomOAuthConnection$, args);
    signal.throwIfAborted();
    return currentAfterLostPublication(current);
  },
);

const handleAutomaticOAuthRefreshFailure$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly observedEncryptedRefreshToken: string;
      readonly binding: CustomConnectorAutomaticOAuthBinding;
      readonly error: unknown;
    },
  ): Promise<{ readonly kind: "reconnect-required" }> => {
    const db = set(writeDb$);
    if (
      isAutomaticOAuthInvalidClient(args.error) &&
      args.binding.registrationMethod === "dcr"
    ) {
      const registrationId = args.binding.dcrRegistration.id;
      await db.execute(
        retireCustomConnectorDcrRegistrationSql(registrationId, nowDate()),
      );
      return { kind: "reconnect-required" };
    }
    if (
      isAutomaticOAuthInvalidGrant(args.error) ||
      isAutomaticOAuthInvalidClient(args.error) ||
      (args.error instanceof McpAutomaticOAuthError &&
        args.error.kind === "binding-drift")
    ) {
      const reconnectDb = db;
      const reconnectConnectorId = args.connectionId;
      const reconnectReason = "authorization_expired_or_revoked";
      const reconnectObservedToken = args.observedEncryptedRefreshToken;
      await (async () => {
        await reconnectDb
          .update(connectors)
          .set({ needsReconnect: true, reconnectReason, updatedAt: nowDate() })
          .where(
            customConnectorRefreshReconnectCondition(
              reconnectConnectorId,
              reconnectObservedToken,
              CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
            ),
          );
      })();
      return { kind: "reconnect-required" };
    }
    if (
      args.error instanceof McpAutomaticOAuthError &&
      args.error.kind === "temporary"
    ) {
      throw new CustomConnectorOAuth2TokenRefreshError(args.error);
    }
    throw args.error;
  },
);

type RefreshAutomaticOAuthAccessTokenContext = {
  readonly args: ResolveCustomConnectorOAuth2AccessTokenArgs;
  readonly connector: CustomConnectorRow & {
    readonly kind: "mcp";
    readonly authMode: "automatic";
  };
  readonly connection: StoredConnection;
};

/**
 * Ordinary refresh for an automatic custom connector: binding/registration
 * reads, KMS and provider HTTP run outside any transaction; publication
 * compares the consumed refresh token.
 */
const refreshAutomaticOAuthAccessToken$ = command(
  async (
    { set },
    context: RefreshAutomaticOAuthAccessTokenContext,
    signal: AbortSignal,
  ): Promise<
    | CustomConnectorOAuth2AccessTokenResolution
    | { readonly kind: "publication-lost" }
  > => {
    const { args, connector, connection } = context;
    const db = set(writeDb$);
    if (!connection.encryptedRefreshToken) {
      return await set(markCustomOAuthRefreshReconnect$, {
        connectionId: connection.id,
        observedEncryptedRefreshToken: null,
        reason: "missing_refresh_token",
      });
    }
    const binding = await (async () => {
      const plan = customConnectorAutomaticOAuthBindingReadPlan(connection.id);
      const [row] = await db
        .select(plan.columns)
        .from(customConnectorAccountOauthBindings)
        .innerJoin(connectors, plan.accountJoin)
        .innerJoin(orgCustomConnectors, plan.connectorJoin)
        .leftJoin(orgCustomConnectorDcrRegistrations, plan.registrationJoin)
        .where(plan.condition)
        .limit(1);
      return customConnectorAutomaticOAuthBindingFromRow(row);
    })();
    signal.throwIfAborted();
    if (!binding) {
      return await set(markCustomOAuthRefreshReconnect$, {
        connectionId: connection.id,
        observedEncryptedRefreshToken: connection.encryptedRefreshToken,
        reason: "authorization_expired_or_revoked",
      });
    }
    if (
      binding.registrationMethod === "dcr" &&
      binding.dcrRegistration.expiresAt !== null &&
      binding.dcrRegistration.expiresAt <= nowDate()
    ) {
      return await set(
        retireAutomaticOAuthRefreshRegistration$,
        binding.dcrRegistration.id,
      );
    }
    const refreshToken = await decryptStoredSecretValue(
      connection.encryptedRefreshToken,
      args.featureContext,
    );
    signal.throwIfAborted();
    const okouClientMetadata = configuredOkouMcpOAuthClientMetadata();
    const [okouRedirectUri] = okouClientMetadata.redirect_uris;
    if (!okouRedirectUri) {
      throw new Error("Okou MCP OAuth callback is unavailable");
    }
    const refreshResult = await settle(
      set(
        refreshCustomConnectorAutomaticOAuthToken$,
        {
          binding,
          endpoint: connector.endpoint,
          redirectUri: okouRedirectUri,
          cimdClientId: okouClientMetadata.client_id,
          refreshToken,
          featureContext: args.featureContext,
        },
        signal,
      ),
      signal,
    );
    if (!refreshResult.ok) {
      return await set(handleAutomaticOAuthRefreshFailure$, {
        connectionId: connection.id,
        observedEncryptedRefreshToken: connection.encryptedRefreshToken,
        binding,
        error: refreshResult.error,
      });
    }
    return await set(
      storeRefreshedConnectionTokens$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connection,
        token: refreshResult.value,
        fallbackRefreshToken: refreshToken,
        featureContext: args.featureContext,
      },
      signal,
    );
  },
);

const resolveAutomaticCustomConnectorOAuth2AccessToken$ = command(
  async (
    { get, set },
    args: ResolveCustomConnectorOAuth2AccessTokenArgs,
    signal: AbortSignal,
  ): Promise<CustomConnectorOAuth2AccessTokenResolution> => {
    if (!isAutomaticOAuthConnector(args.connector)) {
      return { kind: "unavailable" };
    }
    const connector = args.connector;
    const connectionDb = get(db$);
    const connectionIdentity: CustomConnectorOAuthConnectionReadIdentity = {
      orgId: args.orgId,
      userId: args.userId,
      customConnectorId: connector.id,
      memberConnectorId: args.memberConnectorId,
      storageVersion: connector.storageVersion,
      definitionAuthMode: "automatic",
    };
    const connection = await (async (): Promise<StoredConnection | null> => {
      const plan = customConnectorOAuthConnectionReadPlan(connectionIdentity);
      const query = connectionDb
        .select(plan.columns)
        .from(connectors)
        .where(plan.condition);
      const rows = await query.limit(1);
      const connection = rows[0];
      if (!connection) {
        return null;
      }
      // Re-check the complete identity at the secret read boundary because the
      // organization definition can change after the parent lookup.
      const tokenPlan = customConnectorOAuthConnectionTokenReadPlan(
        connectionIdentity,
        connection.id,
      );
      const tokenRows = await connectionDb
        .select(tokenPlan.columns)
        .from(secrets)
        .innerJoin(connectors, tokenPlan.accountJoin)
        .innerJoin(orgCustomConnectors, tokenPlan.definitionJoin)
        .where(tokenPlan.condition);
      return storedConnectionFromRows(connection, tokenRows);
    })();
    signal.throwIfAborted();
    if (!connection) {
      return { kind: "unavailable" };
    }
    const accessToken = storedConnectionAccessToken(connection);
    if (
      !args.forceRefresh &&
      !connection.needsReconnect &&
      accessToken.kind === "available" &&
      connectionAccessTokenIsCurrent(connection)
    ) {
      return accessToken;
    }
    const refreshed = await set(
      refreshAutomaticOAuthAccessToken$,
      { args, connector, connection },
      signal,
    );
    if (refreshed.kind !== "publication-lost") {
      return refreshed;
    }
    const currentConnectionDb = get(db$);
    const currentConnectionIdentity: CustomConnectorOAuthConnectionReadIdentity =
      {
        orgId: args.orgId,
        userId: args.userId,
        customConnectorId: connector.id,
        memberConnectorId: args.memberConnectorId,
        storageVersion: connector.storageVersion,
        definitionAuthMode: "automatic",
      };
    const current = await (async (): Promise<StoredConnection | null> => {
      const plan = customConnectorOAuthConnectionReadPlan(
        currentConnectionIdentity,
      );
      const query = currentConnectionDb
        .select(plan.columns)
        .from(connectors)
        .where(plan.condition);
      const rows = await query.limit(1);
      const connection = rows[0];
      if (!connection) {
        return null;
      }
      // Re-check the complete identity at the secret read boundary because the
      // organization definition can change after the parent lookup.
      const tokenPlan = customConnectorOAuthConnectionTokenReadPlan(
        currentConnectionIdentity,
        connection.id,
      );
      const tokenRows = await currentConnectionDb
        .select(tokenPlan.columns)
        .from(secrets)
        .innerJoin(connectors, tokenPlan.accountJoin)
        .innerJoin(orgCustomConnectors, tokenPlan.definitionJoin)
        .where(tokenPlan.condition);
      return storedConnectionFromRows(connection, tokenRows);
    })();
    signal.throwIfAborted();
    return currentAfterLostPublication(current);
  },
);

export const resolveCurrentCustomConnectorOAuth2AccessToken$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly customConnectorId: string;
      readonly memberConnectorId: string;
      readonly featureContext: FeatureSwitchContext;
      readonly forceRefresh?: boolean;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorOAuth2AccessTokenResolution> => {
    const db = get(db$);
    const connector = await (async (): Promise<CustomConnectorRow | null> => {
      const [row] = await db
        .select({
          connector: customConnectorDefinitionSelection(),
          oauthConfig: orgCustomConnectorOauthConfigs,
        })
        .from(orgCustomConnectors)
        .leftJoin(
          orgCustomConnectorOauthConfigs,
          and(
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
            eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
          ),
        )
        .where(
          and(
            eq(orgCustomConnectors.id, args.customConnectorId),
            eq(orgCustomConnectors.orgId, args.orgId),
            eq(orgCustomConnectors.enabled, true),
          ),
        )
        .limit(1);
      return row
        ? normaliseCustomConnectorRow(row.connector, row.oauthConfig)
        : null;
    })();
    signal.throwIfAborted();
    if (
      !connector ||
      (connector.authMode !== "oauth" && connector.authMode !== "automatic")
    ) {
      return { kind: "unavailable" };
    }
    const resolve =
      connector.authMode === "automatic"
        ? resolveAutomaticCustomConnectorOAuth2AccessToken$
        : resolveCustomConnectorOAuth2AccessToken$;
    return await set(resolve, { ...args, connector }, signal);
  },
);

function customOAuthWriteArgs(
  args: StoreCustomConnectorOAuth2ConnectionArgs,
  resolution: Extract<ConnectorConnectionMutationResolution, { kind: "ready" }>,
): ConnectorConnectionWriteArgs {
  return {
    orgId: args.orgId,
    userId: args.userId,
    authMethod: "oauth",
    storageVersion: args.storageVersion,
    tokenExpiresAt: args.token.expiresAt,
    target: customOAuthConnectionTarget(args.connectorId, args.token),
    resolution: resolution.mutation,
    insertConnectionId: args.insertConnectionId,
  };
}

function automaticNoAuthMutation(
  args: StartCustomConnectorOAuth2Args,
  connector: AutomaticNoAuthConnector,
): ConnectorConnectionMutationArgs {
  return {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "custom", customConnectorId: connector.id },
    mutation: args.account,
    allowSiblings: true,
  };
}

function automaticNoAuthWakeup(
  args: StartCustomConnectorOAuth2Args,
  connector: AutomaticNoAuthConnector,
  connection: { readonly id: string } | null,
): ConnectorRuntimeWakeupBusinessArgs | undefined {
  return connection
    ? {
        scope: { orgId: args.orgId, userId: args.userId },
        targets: [{ kind: "custom", customConnectorId: connector.id }],
      }
    : undefined;
}

function customOAuthQuest(
  args: Pick<StoreCustomConnectorOAuth2ConnectionArgs, "orgId" | "userId">,
) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    questKey: "connector" as const,
    sourceKey: CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY,
  };
}
