import { awardCompletedGetStartedQuest } from "./get-started-rewards.service";
import { feishuPlatformFromTokenUrl } from "@okouai/core/feishu-platform";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, exists } from "drizzle-orm";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
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
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { safeJsonParse, settle } from "../utils";
import { writeDb$, type Db } from "../external/db";
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
import {
  insertConnectorOAuthState,
  type StoredCustomConnectorOAuthState,
} from "./connector-oauth-state.service";
import {
  customConnectorMcpDisabledResponse,
  isCustomConnectorMcpEnabled,
} from "./custom-connector-mcp-feature.service";
import {
  type ConnectorConnectionMutationResolution,
  replaceConnectorConnection,
  resolveConnectorConnectionMutation,
} from "./connector-connection-write.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { addUserCustomConnector } from "./user-connectors.service";
import { commitConnectorRuntimeMutation } from "./connector-runtime-wakeup.service";
import {
  publishCustomConnectorUserInvalidationAfterCommit,
  type CapturedConnectorClientInvalidationAbort,
} from "./connector-client-invalidation.service";
import { mcpOAuthSafeFetch } from "./mcp-oauth-safe-fetch.service";
import {
  CustomConnectorAutomaticOAuthError,
  customConnectorAutomaticOAuthErrorCode,
  isAutomaticOAuthInvalidClient,
  isAutomaticOAuthInvalidGrant,
  prepareCustomConnectorAutomaticOAuthAuthorization,
  prepareCustomConnectorAutomaticOAuthReauthorization,
  readCustomConnectorAutomaticOAuthBinding,
  refreshCustomConnectorAutomaticOAuthToken,
  retireCustomConnectorDcrRegistration,
  type CustomConnectorAutomaticOAuthBinding,
  type CustomConnectorCanonicalAutomaticOAuthStateContext as PreparedCustomConnectorAutomaticOAuthStateContext,
} from "./custom-connector-automatic-oauth.service";
import { configuredOkouMcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.service";

const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

const oauthHttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    return new URL(value).protocol === "https:";
  });

const customConnectorCustomOAuthProviderContextSchema = z
  .object({
    provider: z.literal("feishu"),
    completionTarget: z.enum(["custom", "feishu"]),
    installationId: z.string().uuid().optional(),
    expectedOpenId: z.string().min(1).optional(),
  })
  .strict();

const customConnectorCustomOAuthStateContextSchema = z
  .object({
    version: z.literal(2),
    authMode: z.literal("oauth"),
    connectorId: z.string().uuid(),
    storageVersion: z.number().int().positive(),
    providerContext: customConnectorCustomOAuthProviderContextSchema.optional(),
  })
  .strict();

export type CustomConnectorCustomOAuthStateContext = z.infer<
  typeof customConnectorCustomOAuthStateContextSchema
>;

const customConnectorAutomaticOAuthStateContextCoreSchema = z.object({
  connectorId: z.string().uuid(),
  storageVersion: z.number().int().positive(),
  issuer: oauthHttpsUrlSchema,
  resource: oauthHttpsUrlSchema,
  resourceMetadataUrl: oauthHttpsUrlSchema.nullable(),
  authorizationEndpoint: oauthHttpsUrlSchema,
  tokenEndpoint: oauthHttpsUrlSchema,
  authorizationResponseIssParameterSupported: z.boolean(),
  clientId: z.string().min(1),
  tokenEndpointAuthMethod: z.enum([
    "none",
    "client_secret_basic",
    "client_secret_post",
  ]),
  providerContext: z.never().optional(),
});

const customConnectorAutomaticOAuthStateContextBaseSchema =
  customConnectorAutomaticOAuthStateContextCoreSchema.extend({
    version: z.literal(2),
    authMode: z.literal("automatic"),
  });

const customConnectorAutomaticOAuthStateContextSchema = z.union([
  customConnectorAutomaticOAuthStateContextBaseSchema
    .extend({
      registrationMethod: z.literal("cimd"),
      dcrRegistrationId: z.never().optional(),
    })
    .strict(),
  customConnectorAutomaticOAuthStateContextBaseSchema
    .extend({
      registrationMethod: z.literal("dcr"),
      dcrRegistrationId: z.string().uuid(),
    })
    .strict(),
]);

const customConnectorOAuthStateContextSchema = z.union([
  customConnectorCustomOAuthStateContextSchema,
  customConnectorAutomaticOAuthStateContextSchema,
]);

type CustomConnectorOAuthStateContext = z.infer<
  typeof customConnectorOAuthStateContextSchema
>;

type CustomConnectorAutomaticOAuthStateContext = z.infer<
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

const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullable().optional(),
  id_token: z.string().min(1).nullable().optional(),
  token_type: z.string().min(1).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  scope: z.string().trim().min(1).optional(),
});

const oauthTokenErrorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  error_subtype: z.string().min(1).optional(),
});

export interface OAuthTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
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
  token: OAuthTokenResult,
  authorizationUrl: string | null,
): OAuthTokenResult {
  return token.scopes === null
    ? {
        ...token,
        scopes: customConnectorOAuth2AuthorizationScopes(authorizationUrl),
      }
    : token;
}

function tokenResult(response: PublicHttpsResponse): OAuthTokenResult {
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
): Promise<OAuthTokenResult> {
  const authorization = tokenRequestAuthentication(args);
  const fetched = await mcpOAuthSafeFetch(args.config.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization ? { authorization } : {}),
    },
    body: args.form,
    signal,
  });
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
}): OAuthTokenResult {
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
): Promise<OAuthTokenResult> {
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
  return await requestToken({ ...args, form }, signal);
}

async function refreshCustomConnectorOAuth2Token(
  args: {
    readonly config: CustomConnectorOAuthConfigRow;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<OAuthTokenResult> {
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
  return await requestToken({ ...args, form }, signal);
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

function customConnectorOAuthMcpIsDisabled(
  connector: CustomConnectorRow,
  featureContext: FeatureSwitchContext,
): boolean {
  return (
    connector.kind === "mcp" && !isCustomConnectorMcpEnabled(featureContext)
  );
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
  readonly publicBrand: PublicBrand;
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

async function prepareAutomaticOAuthStart(
  context: {
    readonly db: Db;
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
) {
  const { db, connector, args, featureContext, client } = context;
  const preflight = await db.transaction(async (tx) => {
    await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.orgId,
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      authMode: "automatic",
    });
    return await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: connector.id },
      mutation: args.account,
      allowSiblings: true,
    });
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
    prepareCustomConnectorAutomaticOAuthAuthorization(
      {
        db,
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
    if (!(error instanceof CustomConnectorAutomaticOAuthError)) {
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
}

async function persistCustomConnectorOAuthStart(
  context: {
    readonly db: Db;
    readonly connector: CustomConnectorRow;
    readonly args: StartCustomConnectorOAuth2Args;
    readonly prepared: PreparedOAuthStart;
  },
  signal: AbortSignal,
) {
  const { db, connector, args, prepared } = context;
  const expiresAt = connectorOAuthStateExpiresAt();
  const result = await db.transaction(async (tx) => {
    await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.orgId,
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      authMode: prepared.authMode,
    });
    const resolution = await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: connector.id },
      mutation: args.account,
      allowSiblings: !isIntegrationManagedCustomConnector(connector),
    });
    if (resolution.kind !== "ready") {
      return resolution;
    }
    const oauthStateId = await insertConnectorOAuthState(tx, {
      state: prepared.state,
      customConnectorId: connector.id,
      storageVersion: connector.storageVersion,
      authMethod: "oauth",
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.agentId,
      authorizeAgent: args.agentId !== undefined,
      redirectUri: prepared.redirectUri,
      authorizationUrl: prepared.authorizationUrl,
      oauthRequestedScopes: prepared.oauthRequestedScopes,
      codeVerifier: prepared.codeVerifier,
      oauthContext: JSON.stringify(prepared.context),
      accountMutation: args.account,
      expiresAt,
    });
    return {
      kind: "ready" as const,
      oauthAttemptId: oauthStateId,
      connectionId: args.account.intent === "add" ? oauthStateId : null,
      expiresAt,
    };
  });
  signal.throwIfAborted();
  return result;
}

function automaticNoAuthAgentAuthorizationFailure(
  authorization: Awaited<ReturnType<typeof addUserCustomConnector>>,
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
    case "mcpFeatureDisabled": {
      return badRequestMessage(
        "Authentication connected, but MCP custom connector management is not enabled",
      );
    }
  }
}

async function persistAutomaticNoAuthConnection(
  context: {
    readonly db: Db;
    readonly connector: CustomConnectorRow & {
      readonly kind: "mcp";
      readonly authMode: "automatic";
      readonly oauthConfig: null;
    };
    readonly args: StartCustomConnectorOAuth2Args;
  },
  signal: AbortSignal,
) {
  const { db, connector, args } = context;
  const transaction = db.transaction(async (tx) => {
    await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.orgId,
      connectorId: connector.id,
      storageVersion: connector.storageVersion,
      authMode: "automatic",
    });
    const resolution = await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: connector.id },
      mutation: args.account,
      allowSiblings: true,
    });
    if (resolution.kind !== "ready") {
      return { resolution, connection: null };
    }
    const connection = await replaceConnectorConnection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        authMethod: "none",
        storageVersion: connector.storageVersion,
        tokenExpiresAt: null,
        target: {
          kind: "custom",
          customConnectorId: connector.id,
          oauthScopes: null,
        },
        resolution: resolution.mutation,
        writeCredentials: async ({ db: credentialDb, connectorId }) => {
          await credentialDb
            .delete(customConnectorAccountOauthBindings)
            .where(
              eq(
                customConnectorAccountOauthBindings.connectorAccountId,
                connectorId,
              ),
            );
        },
      },
      signal,
    );
    return { resolution, connection };
  });
  let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
  const result = await commitConnectorRuntimeMutation(transaction, (value) => {
    return value.connection
      ? {
          db,
          scope: { orgId: args.orgId, userId: args.userId },
          targets: [{ kind: "custom", customConnectorId: connector.id }],
        }
      : undefined;
  });
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
  await publishCustomConnectorUserInvalidationAfterCommit(
    args.userId,
    signal,
    postCommitAbort,
  );
  if (args.agentId) {
    const authorization = await addUserCustomConnector(db, {
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
  return {
    result: "connected" as const,
    connector: serialiseCustomConnector({
      row: connector,
      valueMarkers: [],
      connectedAccountId: result.connection.id,
      connectedAccountUpdatedAt: result.connection.updatedAt,
    }),
    connectedAccountId: result.connection.id,
  };
}

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
    const featureContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (customConnectorOAuthMcpIsDisabled(connector, featureContext)) {
      return customConnectorMcpDisabledResponse();
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
      const automatic = await prepareAutomaticOAuthStart(
        {
          db: set(writeDb$),
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
        return await persistAutomaticNoAuthConnection(
          {
            db: set(writeDb$),
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
    const mutationStart = await persistCustomConnectorOAuthStart(
      {
        db: set(writeDb$),
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
    ? z
        .array(mcpOAuthScopeTokenSchema)
        .max(100)
        .parse(safeJsonParse(connection.oauthScopes))
    : [];
  const parsed = mcpOAuthScopeListSchema.safeParse([
    ...new Set([...storedScopes, ...challengedScopes]),
  ]);
  return parsed.success ? parsed.data : null;
}

function automaticOAuthReauthorizationFailure(error: unknown) {
  if (!(error instanceof CustomConnectorAutomaticOAuthError)) {
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

export const startCustomConnectorAutomaticOAuthReauthorization$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorId: string;
      readonly connectionId: string;
      readonly scopes: readonly string[];
    },
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
    if (customConnectorOAuthMcpIsDisabled(connector, featureContext)) {
      return customConnectorMcpDisabledResponse();
    }
    const db = set(writeDb$);
    const connection = await loadConnection({
      db,
      orgId: args.orgId,
      userId: args.userId,
      customConnectorId: connector.id,
      memberConnectorId: args.connectionId,
      storageVersion: connector.storageVersion,
      definitionAuthMode: "automatic",
    });
    signal.throwIfAborted();
    if (
      !connection ||
      connection.needsReconnect ||
      !connection.encryptedAccessToken ||
      !connectionAccessTokenIsCurrent(connection)
    ) {
      return automaticOAuthReauthorizationUnavailable("account");
    }
    const binding = await readCustomConnectorAutomaticOAuthBinding(
      db,
      connection.id,
    );
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
      prepareCustomConnectorAutomaticOAuthReauthorization(
        {
          db,
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
    const persisted = await persistCustomConnectorOAuthStart(
      {
        db,
        connector,
        args: {
          orgId: args.orgId,
          userId: args.userId,
          connectorId: args.connectorId,
          redirectUri,
          publicBrand: "okou",
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
      },
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

async function encryptTokenValues(args: {
  readonly token: OAuthTokenResult;
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

function connectionTokenRows(args: {
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

async function replaceConnectionTokens(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly token: OAuthTokenResult;
  readonly fallbackRefreshToken?: string;
  readonly fallbackEncryptedIdToken?: string;
  readonly featureContext: FeatureSwitchContext;
}): Promise<string> {
  const encrypted = await encryptTokenValues(args);
  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt: args.token.expiresAt,
      needsReconnect: false,
      reconnectReason: null,
      ...(args.token.scopes === null
        ? {}
        : { oauthScopes: JSON.stringify(args.token.scopes) }),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(connectors.id, args.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
      ),
    );
  await args.db
    .delete(secrets)
    .where(eq(secrets.connectorId, args.connectionId));
  await args.db.insert(secrets).values(
    connectionTokenRows({
      ...args,
      encrypted,
    }),
  );
  return encrypted.accessToken;
}

export async function lockCustomConnectorOAuth2CredentialContract(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly authMode: "oauth" | "automatic";
}): Promise<{
  readonly providerAdapter: CustomConnectorOAuthProviderAdapter | null;
}> {
  const [definition] = await args.db
    .select({
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
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
    definition.authMode !== args.authMode ||
    definition.storageVersion !== args.storageVersion
  ) {
    throw new Error(
      "Custom connector credential contract changed during OAuth connection",
    );
  }
  return { providerAdapter: definition.providerAdapter };
}

export async function storeCustomConnectorOAuth2Connection(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly storageVersion: number;
    readonly token: OAuthTokenResult;
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
        | "none"
        | "client_secret_basic"
        | "client_secret_post";
      readonly registrationMethod: "cimd" | "dcr";
      readonly dcrRegistrationId: string | null;
    };
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "stored"; readonly connectionId: string }
  | { readonly kind: "missing" | "ambiguous" | "sibling-disabled" }
> {
  const encrypted = await encryptTokenValues(args);
  signal.throwIfAborted();
  return await args.db.transaction(async (tx) => {
    const contract = await lockCustomConnectorOAuth2CredentialContract({
      db: tx,
      orgId: args.orgId,
      connectorId: args.connectorId,
      storageVersion: args.storageVersion,
      authMode: args.automaticOAuthBinding ? "automatic" : "oauth",
    });
    signal.throwIfAborted();
    const resolution = await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: args.connectorId },
      mutation: args.account,
      allowSiblings: !isIntegrationManagedCustomConnectorProviderAdapter(
        contract.providerAdapter,
      ),
    });
    signal.throwIfAborted();
    if (resolution.kind !== "ready") {
      return resolution;
    }
    const connection = await replaceConnectorConnection(
      tx,
      {
        orgId: args.orgId,
        userId: args.userId,
        authMethod: "oauth",
        storageVersion: args.storageVersion,
        tokenExpiresAt: args.token.expiresAt,
        target: {
          kind: "custom",
          customConnectorId: args.connectorId,
          oauthScopes: args.token.scopes,
        },
        resolution: resolution.mutation,
        insertConnectionId: args.insertConnectionId,
        writeCredentials: async ({ db, connectorId }) => {
          await db.insert(secrets).values(
            connectionTokenRows({
              ...args,
              connectionId: connectorId,
              encrypted,
            }),
          );
          await db
            .delete(customConnectorAccountOauthBindings)
            .where(
              eq(
                customConnectorAccountOauthBindings.connectorAccountId,
                connectorId,
              ),
            );
          if (args.automaticOAuthBinding) {
            await db.insert(customConnectorAccountOauthBindings).values({
              connectorAccountId: connectorId,
              customConnectorId: args.connectorId,
              ...args.automaticOAuthBinding,
            });
          }
        },
      },
      signal,
    );
    await awardCompletedGetStartedQuest(tx, {
      orgId: args.orgId,
      userId: args.userId,
      questKey: "connector",
      sourceKey: `custom:${args.connectorId}`,
    });
    return { kind: "stored", connectionId: connection.id };
  });
}

interface StoredConnection {
  readonly id: string;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
  readonly oauthScopes: string | null;
  readonly encryptedAccessToken: string | null;
  readonly encryptedRefreshToken: string | null;
  readonly encryptedIdToken: string | null;
}

async function loadConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
  readonly storageVersion: number;
  readonly definitionAuthMode: "oauth" | "automatic";
  readonly lockRow?: boolean;
}): Promise<StoredConnection | null> {
  const query = args.db
    .select({
      id: connectors.id,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.memberConnectorId),
        eq(connectors.customConnectorId, args.customConnectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.storageVersion, args.storageVersion),
        exists(
          args.db
            .select({ id: orgCustomConnectors.id })
            .from(orgCustomConnectors)
            .where(
              and(
                eq(orgCustomConnectors.id, args.customConnectorId),
                eq(orgCustomConnectors.orgId, args.orgId),
                eq(orgCustomConnectors.authMode, args.definitionAuthMode),
                eq(orgCustomConnectors.storageVersion, args.storageVersion),
              ),
            ),
        ),
      ),
    );
  const rows = args.lockRow
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const connection = rows[0];
  if (!connection) {
    return null;
  }
  // Re-check the complete identity at the secret read boundary because the
  // organization definition can change after the parent lookup.
  const tokenRows = await args.db
    .select({
      secretName: secrets.name,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .innerJoin(connectors, eq(connectors.id, secrets.connectorId))
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        eq(orgCustomConnectors.authMode, args.definitionAuthMode),
        eq(orgCustomConnectors.storageVersion, args.storageVersion),
      ),
    )
    .where(
      and(
        eq(connectors.id, connection.id),
        eq(connectors.customConnectorId, args.customConnectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.storageVersion, args.storageVersion),
      ),
    );
  return {
    id: connection.id,
    tokenExpiresAt: connection.tokenExpiresAt,
    needsReconnect: connection.needsReconnect,
    oauthScopes: connection.oauthScopes,
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
  | AvailableCustomConnectorOAuth2AccessToken
  | { readonly kind: "unavailable" } {
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

async function markCustomConnectorNeedsReconnect(
  db: Db,
  connectorId: string,
  reconnectReason: "missing_refresh_token" | "authorization_expired_or_revoked",
): Promise<void> {
  await db
    .update(connectors)
    .set({ needsReconnect: true, reconnectReason, updatedAt: nowDate() })
    .where(eq(connectors.id, connectorId));
}

interface ResolveCustomConnectorOAuth2AccessTokenArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: CustomConnectorRow;
  readonly memberConnectorId: string;
  readonly featureContext: FeatureSwitchContext;
  readonly forceRefresh?: boolean;
}

async function loadCustomOAuthConnection(
  args: ResolveCustomConnectorOAuth2AccessTokenArgs,
  lockRow = false,
): Promise<StoredConnection | null> {
  return await loadConnection({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    customConnectorId: args.connector.id,
    memberConnectorId: args.memberConnectorId,
    storageVersion: args.connector.storageVersion,
    definitionAuthMode: "oauth",
    lockRow,
  });
}

async function resolveCustomConnectorOAuth2AccessToken(
  args: ResolveCustomConnectorOAuth2AccessTokenArgs,
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  if (args.connector.authMode !== "oauth" || !args.connector.oauthConfig) {
    return { kind: "unavailable" };
  }
  const oauthConfig = args.connector.oauthConfig;
  const connection = await loadCustomOAuthConnection(args);
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
  return await args.db.transaction(async (tx) => {
    const lockedConnection = await loadCustomOAuthConnection(
      { ...args, db: tx },
      true,
    );
    signal.throwIfAborted();
    if (!lockedConnection) {
      return { kind: "unavailable" };
    }
    const lockedAccessToken = storedConnectionAccessToken(lockedConnection);
    const recoveredSinceInitialRead =
      connection.needsReconnect ||
      accessToken.kind !== "available" ||
      (lockedAccessToken.kind === "available" &&
        lockedAccessToken.encryptedAccessToken !==
          accessToken.encryptedAccessToken);
    if (
      !lockedConnection.needsReconnect &&
      lockedAccessToken.kind === "available" &&
      (!args.forceRefresh || recoveredSinceInitialRead) &&
      connectionAccessTokenIsCurrent(lockedConnection)
    ) {
      return lockedAccessToken;
    }
    if (!lockedConnection.encryptedRefreshToken) {
      await markCustomConnectorNeedsReconnect(
        tx,
        lockedConnection.id,
        "missing_refresh_token",
      );
      return { kind: "reconnect-required" };
    }
    const [credentials, refreshToken] = await Promise.all([
      decryptCustomConnectorOAuth2Credentials(
        args.connector,
        args.featureContext,
      ),
      decryptStoredSecretValue(
        lockedConnection.encryptedRefreshToken,
        args.featureContext,
      ),
    ]);
    signal.throwIfAborted();
    if (!credentials) {
      return { kind: "unavailable" };
    }
    const refreshResult = await settle(
      refreshCustomConnectorOAuth2Token(
        {
          config: oauthConfig,
          clientSecret: credentials.clientSecret,
          refreshToken,
        },
        signal,
      ),
    );
    if (!refreshResult.ok) {
      if (
        !isOAuthProviderHttpError(refreshResult.error) ||
        refreshResult.error.oauthError !== "invalid_grant"
      ) {
        throw new CustomConnectorOAuth2TokenRefreshError(refreshResult.error);
      }
      await markCustomConnectorNeedsReconnect(
        tx,
        lockedConnection.id,
        "authorization_expired_or_revoked",
      );
      return { kind: "reconnect-required" };
    }
    signal.throwIfAborted();
    const encryptedAccessToken = await replaceConnectionTokens({
      db: tx,
      connectionId: lockedConnection.id,
      orgId: args.orgId,
      userId: args.userId,
      token: refreshResult.value,
      fallbackRefreshToken: refreshToken,
      fallbackEncryptedIdToken: lockedConnection.encryptedIdToken ?? undefined,
      featureContext: args.featureContext,
    });
    signal.throwIfAborted();
    return {
      kind: "available",
      encryptedAccessToken,
      tokenExpiresAt: refreshResult.value.expiresAt,
      status: "refreshed",
    };
  });
}

async function handleAutomaticOAuthRefreshFailure(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly binding: CustomConnectorAutomaticOAuthBinding;
  readonly error: unknown;
}): Promise<{ readonly kind: "reconnect-required" }> {
  if (
    isAutomaticOAuthInvalidClient(args.error) &&
    args.binding.registrationMethod === "dcr"
  ) {
    await retireCustomConnectorDcrRegistration(
      args.db,
      args.binding.dcrRegistration.id,
    );
    return { kind: "reconnect-required" };
  }
  if (
    isAutomaticOAuthInvalidGrant(args.error) ||
    isAutomaticOAuthInvalidClient(args.error) ||
    (args.error instanceof CustomConnectorAutomaticOAuthError &&
      args.error.kind === "binding-drift")
  ) {
    await markCustomConnectorNeedsReconnect(
      args.db,
      args.connectionId,
      "authorization_expired_or_revoked",
    );
    return { kind: "reconnect-required" };
  }
  if (
    args.error instanceof CustomConnectorAutomaticOAuthError &&
    args.error.kind === "temporary"
  ) {
    throw new CustomConnectorOAuth2TokenRefreshError(args.error);
  }
  throw args.error;
}

async function refreshLockedAutomaticOAuthAccessToken(
  context: {
    readonly db: Db;
    readonly args: ResolveCustomConnectorOAuth2AccessTokenArgs;
    readonly connector: CustomConnectorRow & {
      readonly kind: "mcp";
      readonly authMode: "automatic";
    };
    readonly initialConnection: StoredConnection;
    readonly initialAccessToken: ReturnType<typeof storedConnectionAccessToken>;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  const { db, args, connector, initialConnection, initialAccessToken } =
    context;
  const lockedConnection = await loadConnection({
    db,
    orgId: args.orgId,
    userId: args.userId,
    customConnectorId: connector.id,
    memberConnectorId: args.memberConnectorId,
    storageVersion: connector.storageVersion,
    definitionAuthMode: "automatic",
    lockRow: true,
  });
  signal.throwIfAborted();
  if (!lockedConnection) {
    return { kind: "unavailable" };
  }
  const lockedAccessToken = storedConnectionAccessToken(lockedConnection);
  const recoveredSinceInitialRead =
    initialConnection.needsReconnect ||
    initialAccessToken.kind !== "available" ||
    (lockedAccessToken.kind === "available" &&
      lockedAccessToken.encryptedAccessToken !==
        initialAccessToken.encryptedAccessToken);
  if (
    !lockedConnection.needsReconnect &&
    lockedAccessToken.kind === "available" &&
    (!args.forceRefresh || recoveredSinceInitialRead) &&
    connectionAccessTokenIsCurrent(lockedConnection)
  ) {
    return lockedAccessToken;
  }
  if (!lockedConnection.encryptedRefreshToken) {
    await markCustomConnectorNeedsReconnect(
      db,
      lockedConnection.id,
      "missing_refresh_token",
    );
    return { kind: "reconnect-required" };
  }
  const binding = await readCustomConnectorAutomaticOAuthBinding(
    db,
    lockedConnection.id,
  );
  signal.throwIfAborted();
  if (!binding) {
    await markCustomConnectorNeedsReconnect(
      db,
      lockedConnection.id,
      "authorization_expired_or_revoked",
    );
    return { kind: "reconnect-required" };
  }
  if (
    binding.registrationMethod === "dcr" &&
    binding.dcrRegistration.expiresAt !== null &&
    binding.dcrRegistration.expiresAt <= nowDate()
  ) {
    await retireCustomConnectorDcrRegistration(db, binding.dcrRegistration.id);
    return { kind: "reconnect-required" };
  }
  const refreshToken = await decryptStoredSecretValue(
    lockedConnection.encryptedRefreshToken,
    args.featureContext,
  );
  signal.throwIfAborted();
  const okouClientMetadata = configuredOkouMcpOAuthClientMetadata();
  const [okouRedirectUri] = okouClientMetadata.redirect_uris;
  if (!okouRedirectUri) {
    throw new Error("Okou MCP OAuth callback is unavailable");
  }
  const refreshResult = await settle(
    refreshCustomConnectorAutomaticOAuthToken(
      {
        db,
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
    return await handleAutomaticOAuthRefreshFailure({
      db,
      connectionId: lockedConnection.id,
      binding,
      error: refreshResult.error,
    });
  }
  const encryptedAccessToken = await replaceConnectionTokens({
    db,
    connectionId: lockedConnection.id,
    orgId: args.orgId,
    userId: args.userId,
    token: refreshResult.value,
    fallbackRefreshToken: refreshToken,
    fallbackEncryptedIdToken: lockedConnection.encryptedIdToken ?? undefined,
    featureContext: args.featureContext,
  });
  signal.throwIfAborted();
  return {
    kind: "available",
    encryptedAccessToken,
    tokenExpiresAt: refreshResult.value.expiresAt,
    status: "refreshed",
  };
}

async function resolveAutomaticCustomConnectorOAuth2AccessToken(
  args: ResolveCustomConnectorOAuth2AccessTokenArgs,
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  if (!isAutomaticOAuthConnector(args.connector)) {
    return { kind: "unavailable" };
  }
  const connector = args.connector;
  const connection = await loadConnection({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    customConnectorId: connector.id,
    memberConnectorId: args.memberConnectorId,
    storageVersion: connector.storageVersion,
    definitionAuthMode: "automatic",
  });
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
  return await args.db.transaction(async (tx) => {
    return await refreshLockedAutomaticOAuthAccessToken(
      {
        db: tx,
        args,
        connector,
        initialConnection: connection,
        initialAccessToken: accessToken,
      },
      signal,
    );
  });
}

async function loadLiveCustomConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly customConnectorId: string;
}): Promise<CustomConnectorRow | null> {
  const [row] = await args.db
    .select({
      connector: customConnectorDefinitionSelection(),
      oauthConfig: orgCustomConnectorOauthConfigs,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
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
}

export async function resolveCurrentCustomConnectorOAuth2AccessToken(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
    readonly memberConnectorId: string;
    readonly featureContext: FeatureSwitchContext;
    readonly forceRefresh?: boolean;
  },
  signal: AbortSignal,
): Promise<CustomConnectorOAuth2AccessTokenResolution> {
  const connector = await loadLiveCustomConnector(args);
  signal.throwIfAborted();
  if (
    !connector ||
    (connector.authMode !== "oauth" && connector.authMode !== "automatic")
  ) {
    return { kind: "unavailable" };
  }
  const resolve =
    connector.authMode === "automatic"
      ? resolveAutomaticCustomConnectorOAuth2AccessToken
      : resolveCustomConnectorOAuth2AccessToken;
  return await resolve(
    {
      ...args,
      connector,
    },
    signal,
  );
}
