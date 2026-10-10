import {
  IssuerMismatchError,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { secrets } from "@okouai/db/schema/secret";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeJsonParse, safeSync, settle } from "../utils";
import {
  automaticAccountExists$,
  publishAutomaticConnection$,
  type AutomaticConnectionPublication,
} from "./builtin-connector-automatic-connection.service";
import {
  createBuiltinDcrRegistration$,
  hasBuiltinDcrLinkedAccounts$,
  readBuiltinDcrBoundClient$,
  readBuiltinDcrRegistrationByIssuer$,
  retireBuiltinDcrRegistration$,
  retireBuiltinDcrRegistrationSql,
  type BuiltinConnectorAutomaticContractOwner,
} from "./builtin-connector-automatic-dcr.service";
import type { ResolvedConnectorActionMethod } from "./connector-action-resolver.service";
import {
  getConnectorRuntimeMethod,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionFromRows,
  connectorRuntimeSlugSelectionReadPlan,
} from "./connector-catalog-slug-source.service";
import {
  claimBuiltinConnectorOAuthState$,
  insertConnectorOAuthState,
  type StoredBuiltinOAuthState,
} from "./connector-oauth-state.service";
import { publishConnectorRuntimeSyncWakeups$ } from "./connector-runtime-wakeup.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  McpAutomaticOAuthError,
  exchangeMcpAutomaticOAuthCode,
  isAutomaticOAuthInvalidClient,
  isAutomaticOAuthInvalidGrant,
  prepareMcpAutomaticOAuthAuthorization,
  refreshMcpAutomaticOAuthToken,
  validateMcpAutomaticOAuthCallbackIssuer,
  type McpAutomaticOAuthBinding,
  type McpAutomaticOAuthTokenResult,
} from "./mcp-automatic-oauth.service";
import { configuredOkouMcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.service";
import { resolveRefreshedOAuthIdentity } from "./mcp-oauth-identity.service";

const httpsUrl = z.url({ protocol: /^https$/u });
const contextBase = z.object({
  version: z.literal(1),
  kind: z.literal("connector-mcp-automatic"),
  connectorSlug: connectorSlugSchema,
  authMethodId: connectorAuthMethodIdSchema,
  issuer: httpsUrl,
  resource: httpsUrl,
  resourceMetadataUrl: httpsUrl.nullable(),
  authorizationEndpoint: httpsUrl,
  tokenEndpoint: httpsUrl,
  authorizationResponseIssParameterSupported: z.boolean(),
  clientId: z.string().min(1),
  tokenEndpointAuthMethod: z.enum([
    "none",
    "client_secret_basic",
    "client_secret_post",
  ]),
});
const builtinAutomaticContextSchema = z.union([
  contextBase.extend({
    registrationMethod: z.literal("cimd"),
    tokenEndpointAuthMethod: z.literal("none"),
  }),
  contextBase.extend({
    registrationMethod: z.literal("dcr"),
    dcrRegistrationId: z.uuid(),
  }),
]);
type BuiltinAutomaticMethod = Extract<
  ConnectorAuthMethodRuntimeConfig,
  { readonly grant: { readonly kind: "automatic" } }
>;
interface BuiltinAutomaticContract {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly storageVersion: number;
  readonly endpoint: string;
  readonly method: BuiltinAutomaticMethod;
}
type BuiltinAutomaticOAuthBinding = McpAutomaticOAuthBinding & {
  readonly endpoint: string;
};
type FailureReason =
  | "invalid-account"
  | "stale-contract"
  | "invalid-state"
  | "oauth-failed"
  | "unsafe"
  | "temporary"
  | "incompatible";
interface Failure {
  readonly kind: "error";
  readonly reason: FailureReason;
  readonly connectorSlug?: string;
}

function contractFromMethod(
  runtime: ConnectorRuntimeMethod,
  endpoint: string | undefined,
): BuiltinAutomaticContract | null {
  const { connectorSlug, authMethodId, method } = runtime;
  if (
    endpoint === undefined ||
    method.grant.kind !== "automatic" ||
    method.access.kind !== "automatic"
  ) {
    return null;
  }
  return {
    connectorSlug,
    authMethodId,
    endpoint,
    storageVersion: method.storage.version,
    method: {
      storage: method.storage,
      grant: method.grant,
      access: method.access,
      revoke: { kind: "none" },
    },
  };
}

function currentContractFromSnapshot(
  snapshot: ConnectorRuntimeSelection,
  connectorSlug: string,
  authMethodId: string,
): BuiltinAutomaticContract | null {
  const runtime = getConnectorRuntimeMethod({
    snapshot,
    connectorSlug,
    authMethodId,
    requireExecutable: true,
  });
  return runtime
    ? contractFromMethod(
        runtime,
        snapshot.connectors.get(connectorSlug)?.catalogConnector.mcp?.endpoint,
      )
    : null;
}

const currentBuiltinAutomaticContract$ = command(
  async (
    { set },
    args: { readonly connectorSlug: string; readonly authMethodId: string },
    signal: AbortSignal,
  ): Promise<BuiltinAutomaticContract | null> => {
    const db = set(writeDb$);
    const plan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [args.connectorSlug],
    });
    const rows = await db
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    signal.throwIfAborted();
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      plan.selection,
      rows,
    );
    signal.throwIfAborted();
    return currentContractFromSnapshot(
      snapshot,
      args.connectorSlug,
      args.authMethodId,
    );
  },
);

function contractOwner(
  orgId: string,
  contract: BuiltinAutomaticContract,
): BuiltinConnectorAutomaticContractOwner {
  return {
    orgId,
    connectorSlug: contract.connectorSlug,
    authMethod: contract.authMethodId,
  };
}

function failure(error: unknown): Failure {
  if (error instanceof McpAutomaticOAuthError) {
    return {
      kind: "error",
      reason: error.kind === "binding-drift" ? "stale-contract" : error.kind,
    };
  }
  if (
    isAutomaticOAuthInvalidClient(error) ||
    isAutomaticOAuthInvalidGrant(error)
  ) {
    return { kind: "error", reason: "oauth-failed" };
  }
  throw error;
}

function tokenStorageName(
  contract: BuiltinAutomaticContract,
  key: "accessToken" | "refreshToken" | "idToken",
): string | null {
  const ref = contract.method.grant.outputs[key];
  if (ref === undefined) {
    return null;
  }
  if (!ref.startsWith("$secrets.")) {
    throw new Error("Automatic MCP tokens must use secret storage");
  }
  const name = ref.slice("$secrets.".length);
  if (!contract.method.storage.secrets.includes(name)) {
    throw new Error("Automatic MCP token storage is undeclared");
  }
  return name;
}

interface EncryptedAutomaticToken {
  readonly name: string;
  readonly encryptedValue: string;
}

async function encryptAutomaticTokens(
  args: {
    readonly contract: BuiltinAutomaticContract;
    readonly token: McpAutomaticOAuthTokenResult;
    readonly fallbackRefreshToken?: string;
  },
  signal: AbortSignal,
): Promise<readonly EncryptedAutomaticToken[]> {
  const tokens = {
    accessToken: args.token.accessToken,
    refreshToken: args.token.refreshToken ?? args.fallbackRefreshToken,
    idToken: args.token.idToken,
  };
  const encrypted: EncryptedAutomaticToken[] = [];
  for (const key of ["accessToken", "refreshToken", "idToken"] as const) {
    const name = tokenStorageName(args.contract, key);
    const value = tokens[key];
    if (!name || !value) {
      continue;
    }
    encrypted.push({
      name,
      encryptedValue: await encryptStoredSecretValue(value),
    });
    signal.throwIfAborted();
  }
  return encrypted;
}

const prepareBuiltinAutomaticAuthorization$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly contract: BuiltinAutomaticContract;
      readonly redirectUri: string;
      readonly state: string;
      readonly cimdClientId: string;
      readonly dcrClientMetadata: OAuthClientMetadata;
    },
    signal: AbortSignal,
  ) => {
    const { contract } = args;
    return await prepareMcpAutomaticOAuthAuthorization(
      {
        dcrStore: {
          readByIssuer: async (issuer) => {
            return await set(
              readBuiltinDcrRegistrationByIssuer$,
              {
                owner: contractOwner(args.orgId, contract),
                issuer,
              },
              signal,
            );
          },
          hasLinkedAccounts: async (registrationId) => {
            return await set(
              hasBuiltinDcrLinkedAccounts$,
              registrationId,
              signal,
            );
          },
          retire: async (id) => {
            await set(
              retireBuiltinDcrRegistration$,
              { owner: contractOwner(args.orgId, contract), id },
              signal,
            );
          },
          create: async (value, createSignal) => {
            return await set(
              createBuiltinDcrRegistration$,
              {
                owner: contractOwner(args.orgId, contract),
                value,
              },
              createSignal,
            );
          },
        },
        endpoint: contract.endpoint,
        redirectUri: args.redirectUri,
        state: args.state,
        cimdClientId: args.cimdClientId,
        dcrClientMetadata: args.dcrClientMetadata,
      },
      signal,
    );
  },
);

interface StartBuiltinAutomaticArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly resolved: ResolvedConnectorActionMethod;
  readonly account: ConnectorAccountMutationIntent;
  readonly agentId: string | null;
  readonly authorizeAgent: boolean;
  readonly redirectUri: string;
  readonly cimdClientId: string;
  readonly dcrClientMetadata: OAuthClientMetadata;
}

type StartedBuiltinAutomatic =
  | Failure
  | {
      readonly kind: "authorization";
      readonly authorizationUrl: string;
      readonly oauthAttemptId: string;
    }
  | { readonly kind: "connected"; readonly connectionId: string };

export const startBuiltinConnectorAutomatic$ = command(
  async (
    { set },
    args: StartBuiltinAutomaticArgs,
    signal: AbortSignal,
  ): Promise<StartedBuiltinAutomatic> => {
    const contract = contractFromMethod(
      args.resolved.runtimeMethod,
      args.resolved.catalogConnector.mcp?.endpoint,
    );
    if (!contract) {
      return { kind: "error", reason: "stale-contract" };
    }
    if (
      args.account.intent === "reconnect" &&
      !(await set(
        automaticAccountExists$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: contract.connectorSlug,
          connectionId: args.account.connectionId,
        },
        signal,
      ))
    ) {
      return { kind: "error", reason: "invalid-account" };
    }
    const state = generateConnectorOAuthState();
    const prepared = await settle(
      set(
        prepareBuiltinAutomaticAuthorization$,
        {
          orgId: args.orgId,
          contract,
          redirectUri: args.redirectUri,
          state,
          cimdClientId: args.cimdClientId,
          dcrClientMetadata: args.dcrClientMetadata,
        },
        signal,
      ),
      signal,
    );
    if (!prepared.ok) {
      return failure(prepared.error);
    }
    if (prepared.value.kind === "none") {
      const connected = await set(
        publishAutomaticConnection$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: contract.connectorSlug,
          authMethod: contract.authMethodId,
          storageVersion: contract.storageVersion,
          account: args.account,
          binding: null,
          identity: null,
          expiresAt: null,
          scopes: null,
          credentials: [],
        },
        signal,
      );
      if (connected.kind === "connected") {
        await set(
          publishConnectorRuntimeSyncWakeups$,
          {
            scope: { orgId: args.orgId, userId: args.userId },
            targets: [
              { kind: "builtin", connectorSlug: contract.connectorSlug },
            ],
          },
          signal,
        );
      }
      signal.throwIfAborted();
      return connected;
    }
    const authorization = prepared.value;
    const context = builtinAutomaticContextSchema.parse({
      ...authorization.context,
      version: 1,
      kind: "connector-mcp-automatic",
      connectorSlug: contract.connectorSlug,
      authMethodId: contract.authMethodId,
    });
    const oauthAttemptId = await insertConnectorOAuthState(set(writeDb$), {
      state,
      connectorSlug: contract.connectorSlug,
      authMethod: contract.authMethodId,
      storageVersion: null,
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.agentId,
      authorizeAgent: args.authorizeAgent,
      redirectUri: args.redirectUri,
      authorizationUrl: authorization.authorizationUrl,
      codeVerifier: authorization.codeVerifier,
      oauthRequestedScopes: authorization.requestedScope,
      oauthContext: JSON.stringify(context),
      accountMutation: args.account,
      expiresAt: connectorOAuthStateExpiresAt(),
    });
    signal.throwIfAborted();
    return {
      kind: "authorization",
      authorizationUrl: authorization.authorizationUrl,
      oauthAttemptId,
    };
  },
);

async function prepareAutomaticCallbackPublication(
  args: {
    readonly stored: StoredBuiltinOAuthState;
    readonly context: z.infer<typeof builtinAutomaticContextSchema>;
    readonly contract: BuiltinAutomaticContract;
    readonly token: McpAutomaticOAuthTokenResult;
  },
  signal: AbortSignal,
): Promise<AutomaticConnectionPublication> {
  const { stored, context, contract, token } = args;
  const credentials = [];
  for (const key of ["accessToken", "refreshToken", "idToken"] as const) {
    const name = tokenStorageName(contract, key);
    const value = token[key];
    if (name && value) {
      credentials.push({
        name,
        encryptedValue: await encryptStoredSecretValue(value),
      });
      signal.throwIfAborted();
    }
  }
  return {
    orgId: stored.orgId,
    userId: stored.userId,
    connectorSlug: contract.connectorSlug,
    authMethod: contract.authMethodId,
    storageVersion: contract.storageVersion,
    account: stored.accountMutation,
    identity: token.userInfo,
    expiresAt: token.expiresAt,
    scopes: token.scopes,
    credentials,
    binding: {
      orgId: stored.orgId,
      userId: stored.userId,
      connectorSlug: contract.connectorSlug,
      authMethod: contract.authMethodId,
      storageVersion: contract.storageVersion,
      endpoint: contract.endpoint,
      issuer: context.issuer,
      resource: context.resource,
      resourceMetadataUrl: context.resourceMetadataUrl,
      tokenEndpoint: context.tokenEndpoint,
      clientId: context.clientId,
      tokenEndpointAuthMethod: context.tokenEndpointAuthMethod,
      registrationMethod: context.registrationMethod,
      dcrRegistrationId:
        context.registrationMethod === "dcr" ? context.dcrRegistrationId : null,
    },
  };
}

const finishAutomaticOAuth$ = command(
  async (
    { set },
    args: {
      readonly stored: StoredBuiltinOAuthState;
      readonly context: z.infer<typeof builtinAutomaticContextSchema>;
      readonly contract: BuiltinAutomaticContract | null;
      readonly code: string;
      readonly codeVerifier: string;
      readonly issuer: string | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { stored, context, contract } = args;
    if (!contract) {
      return { kind: "error", reason: "stale-contract" } as const;
    }
    const owner = contractOwner(stored.orgId, contract);
    const client =
      context.registrationMethod === "dcr"
        ? await set(
            readBuiltinDcrBoundClient$,
            { owner, id: context.dcrRegistrationId },
            signal,
          )
        : null;
    const exchanged = await settle(
      exchangeMcpAutomaticOAuthCode(
        {
          dcrStore: {
            readBoundClient: (id) => {
              return Promise.resolve(client?.id === id ? client : null);
            },
          },
          context,
          redirectUri: stored.redirectUri,
          cimdClientId: configuredOkouMcpOAuthClientMetadata().client_id,
          code: args.code,
          iss: args.issuer,
          codeVerifier: args.codeVerifier,
        },
        signal,
      ),
      signal,
    );
    if (!exchanged.ok) {
      if (
        isAutomaticOAuthInvalidClient(exchanged.error) &&
        context.registrationMethod === "dcr"
      ) {
        await set(
          retireBuiltinDcrRegistration$,
          { owner, id: context.dcrRegistrationId },
          signal,
        );
      }
      return failure(exchanged.error);
    }
    const publication = await prepareAutomaticCallbackPublication(
      { stored, context, contract, token: exchanged.value },
      signal,
    );
    const published = await set(
      publishAutomaticConnection$,
      publication,
      signal,
    );
    if (published.kind !== "connected") {
      return published;
    }
    await set(
      publishConnectorRuntimeSyncWakeups$,
      {
        scope: { orgId: stored.orgId, userId: stored.userId },
        targets: [{ kind: "builtin", connectorSlug: stored.connectorSlug }],
      },
      signal,
    );
    return {
      kind: "connected",
      connectorSlug: stored.connectorSlug,
      connectionId: published.connectionId,
      orgId: stored.orgId,
      userId: stored.userId,
      agentId: stored.agentId,
      authorizeAgent: stored.authorizeAgent,
      oauthAttemptId: stored.id,
    } as const;
  },
);

type CompletedBuiltinAutomaticOAuth =
  | Failure
  | {
      readonly kind: "connected";
      readonly connectorSlug: string;
      readonly connectionId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly oauthAttemptId: string;
    };

export const completeBuiltinConnectorAutomatic$ = command(
  async (
    { set },
    args: {
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
      readonly errorDescription?: string;
      readonly issuer?: string;
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<CompletedBuiltinAutomaticOAuth> => {
    const db = set(writeDb$);
    const [candidate] = await db
      .select({
        connectorSlug: connectorOauthStates.connectorSlug,
        oauthContext: connectorOauthStates.oauthContext,
      })
      .from(connectorOauthStates)
      .where(
        and(
          eq(connectorOauthStates.state, args.state),
          isNull(connectorOauthStates.customConnectorId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !candidate?.connectorSlug ||
      !candidate.oauthContext ||
      !builtinAutomaticContextSchema.safeParse(
        safeJsonParse(candidate.oauthContext),
      ).success
    ) {
      return { kind: "error", reason: "invalid-state" };
    }
    const claimed = await set(
      claimBuiltinConnectorOAuthState$,
      {
        state: args.state,
        connectorSlug: candidate.connectorSlug,
      },
      signal,
    );
    if (claimed.kind !== "usable") {
      return { kind: "error", reason: "invalid-state" };
    }
    const stored = claimed.state;
    const parsed = builtinAutomaticContextSchema.safeParse(
      stored.oauthContext === null ? null : safeJsonParse(stored.oauthContext),
    );
    if (
      !parsed.success ||
      parsed.data.connectorSlug !== stored.connectorSlug ||
      parsed.data.authMethodId !== stored.authMethod ||
      stored.redirectUri !== args.redirectUri ||
      !stored.codeVerifier
    ) {
      return {
        kind: "error",
        reason: "invalid-state",
        connectorSlug: stored.connectorSlug,
      };
    }
    const context = parsed.data;
    if (args.error || !args.code) {
      return {
        kind: "error",
        reason: "oauth-failed",
        connectorSlug: stored.connectorSlug,
      };
    }
    const code = args.code;
    const codeVerifier = stored.codeVerifier;
    const issuerValidation = safeSync(() => {
      validateMcpAutomaticOAuthCallbackIssuer(context, args.issuer);
    });
    if (!("ok" in issuerValidation)) {
      if (!(issuerValidation.error instanceof IssuerMismatchError)) {
        throw issuerValidation.error;
      }
      return {
        kind: "error",
        reason: "oauth-failed",
        connectorSlug: stored.connectorSlug,
      };
    }
    // COMMIT may finish after cancellation; publish its wakeup before the
    // route observes the cancelled request.
    const contract = await set(
      currentBuiltinAutomaticContract$,
      {
        connectorSlug: stored.connectorSlug,
        authMethodId: stored.authMethod,
      },
      signal,
    );
    const operation = await settle(
      set(
        finishAutomaticOAuth$,
        {
          stored,
          context,
          contract,
          code,
          codeVerifier,
          issuer: args.issuer,
        },
        signal,
      ),
      signal,
    );
    if (!operation.ok) {
      return {
        ...failure(operation.error),
        connectorSlug: stored.connectorSlug,
      };
    }
    return operation.value;
  },
);

const readBuiltinConnectorAutomaticOAuthBinding$ = command(
  async (
    { set },
    connectorId: string,
    signal: AbortSignal,
  ): Promise<BuiltinAutomaticOAuthBinding | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        binding: builtinConnectorAccountOauthBindings,
      })
      .from(builtinConnectorAccountOauthBindings)
      .innerJoin(
        connectors,
        and(
          eq(
            connectors.id,
            builtinConnectorAccountOauthBindings.connectorAccountId,
          ),
          eq(
            connectors.connectorSlug,
            builtinConnectorAccountOauthBindings.connectorSlug,
          ),
          eq(connectors.orgId, builtinConnectorAccountOauthBindings.orgId),
          eq(connectors.userId, builtinConnectorAccountOauthBindings.userId),
        ),
      )
      .where(eq(connectors.id, connectorId))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const binding = row.binding;
    if (binding.registrationMethod === "cimd") {
      return { ...binding, registrationMethod: "cimd", dcrRegistration: null };
    }
    if (binding.dcrRegistrationId === null) {
      return null;
    }
    const [storedRegistration] = await db
      .select()
      .from(builtinConnectorDcrRegistrations)
      .where(
        and(
          eq(builtinConnectorDcrRegistrations.id, binding.dcrRegistrationId),
          eq(builtinConnectorDcrRegistrations.orgId, binding.orgId),
          eq(
            builtinConnectorDcrRegistrations.connectorSlug,
            binding.connectorSlug,
          ),
          eq(builtinConnectorDcrRegistrations.authMethod, binding.authMethod),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const registration = storedRegistration
      ? {
          ...storedRegistration,
          hasClientSecret: storedRegistration.encryptedClientSecret !== null,
        }
      : null;
    if (!registration) {
      return null;
    }
    return {
      ...binding,
      registrationMethod: "dcr",
      dcrRegistration: registration,
    };
  },
);

type CredentialResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "oauth";
      readonly accessToken: string;
      readonly tokenExpiresAt: Date | null;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "reconnect" | "temporary" | "stale-contract";
    };

interface ResolveAutomaticCredentialArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly forceRefresh?: boolean;
}

const markReconnect$ = command(
  async (
    { set },
    connectorId: string,
    signal: AbortSignal,
  ): Promise<CredentialResult> => {
    signal.throwIfAborted();
    await set(writeDb$)
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, connectorId));
    signal.throwIfAborted();
    return { kind: "unavailable", reason: "reconnect" };
  },
);

const publishRefreshedAutomaticCredential$ = command(
  async (
    { set },
    input: {
      readonly args: ResolveAutomaticCredentialArgs;
      readonly account: typeof connectors.$inferSelect;
      readonly token: McpAutomaticOAuthTokenResult;
      readonly tokens: readonly EncryptedAutomaticToken[];
    },
    signal: AbortSignal,
  ): Promise<CredentialResult> => {
    const { args, account, token, tokens } = input;
    const identity = resolveRefreshedOAuthIdentity(
      {
        externalId: account.externalId,
        externalUsername: account.externalUsername,
        externalEmail: account.externalEmail,
      },
      token.userInfo,
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const updatedAccount = db
      .update(connectors)
      .set({
        tokenExpiresAt: token.expiresAt,
        oauthGrantedScopes:
          token.scopes === null
            ? account.oauthGrantedScopes
            : JSON.stringify(token.scopes),
        ...(identity.kind === "update"
          ? {
              externalId: identity.externalId,
              externalUsername: identity.externalUsername,
              externalEmail: identity.externalEmail,
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(connectors.id, account.id),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connectorSlug),
          eq(connectors.authMethod, args.authMethodId),
        ),
      )
      .returning({
        id: connectors.id,
        orgId: connectors.orgId,
        userId: connectors.userId,
      });
    // Output bindings may share a storage name: preserve the ordered loop's last write.
    const publishedTokens = [
      ...new Map(
        tokens.map((token) => {
          return [token.name, token];
        }),
      ).values(),
    ];
    const tokenValues = publishedTokens.map((token) => {
      return sql`(${token.name}::text, ${token.encryptedValue}::text)`;
    });
    // The upsert consumes the owned account's RETURNING row. A deleted account
    // publishes no credentials; any constraint failure rolls back both writes.
    const { rowCount } = await db.execute(sql`
      WITH refreshed_account AS (${updatedAccount.getSQL()})
      INSERT INTO ${secrets}
        (name, encrypted_value, description, type, connector_id, org_id, user_id)
      SELECT token.name, token.encrypted_value, 'Automatic MCP OAuth token',
        'connector', refreshed_account.id, refreshed_account.org_id, refreshed_account.user_id
      FROM refreshed_account
      CROSS JOIN (VALUES ${sql.join(tokenValues, sql`, `)}) AS token(name, encrypted_value)
      ON CONFLICT (connector_id, name) WHERE connector_id IS NOT NULL
      DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
        updated_at = ${sql.param(nowDate(), secrets.updatedAt)}
    `);
    signal.throwIfAborted();
    if (rowCount === 0) {
      return { kind: "unavailable", reason: "reconnect" };
    }
    return {
      kind: "oauth",
      accessToken: token.accessToken,
      tokenExpiresAt: token.expiresAt,
    };
  },
);

/**
 * Provider refresh and encryption finish before atomic token/account publication.
 */
const refreshAutomatic = command(
  async (
    { set },
    context: {
      readonly args: ResolveAutomaticCredentialArgs;
      readonly contract: BuiltinAutomaticContract;
      readonly binding: BuiltinAutomaticOAuthBinding;
      readonly account: typeof connectors.$inferSelect;
      readonly encryptedRefreshToken: string;
    },
    signal: AbortSignal,
  ): Promise<CredentialResult> => {
    const { args, contract, binding, account, encryptedRefreshToken } = context;
    const owner = contractOwner(args.orgId, contract);
    const refreshToken = await decryptStoredSecretValue(encryptedRefreshToken);
    signal.throwIfAborted();
    const metadata = configuredOkouMcpOAuthClientMetadata();
    const redirectUri = metadata.redirect_uris.find((uri) => {
      return new URL(uri).pathname === "/api/connectors/automatic/callback";
    });
    if (!redirectUri) {
      throw new Error("Builtin Automatic OAuth redirect URI is unavailable");
    }
    const refreshed = await settle(
      refreshMcpAutomaticOAuthToken(
        {
          dcrStore: {
            readBoundClient: async (id) => {
              return await set(
                readBuiltinDcrBoundClient$,
                { owner, id },
                signal,
              );
            },
          },
          binding,
          endpoint: contract.endpoint,
          redirectUri,
          cimdClientId: metadata.client_id,
          refreshToken,
        },
        signal,
      ),
      signal,
    );
    if (!refreshed.ok) {
      if (
        isAutomaticOAuthInvalidClient(refreshed.error) &&
        binding.registrationMethod === "dcr"
      ) {
        await set(
          retireBuiltinDcrRegistration$,
          { owner, id: binding.dcrRegistration.id },
          signal,
        );
        return { kind: "unavailable", reason: "reconnect" };
      }
      if (
        isAutomaticOAuthInvalidClient(refreshed.error) ||
        isAutomaticOAuthInvalidGrant(refreshed.error) ||
        (refreshed.error instanceof McpAutomaticOAuthError &&
          refreshed.error.kind === "binding-drift")
      ) {
        return await set(markReconnect$, account.id, signal);
      }
      if (
        refreshed.error instanceof McpAutomaticOAuthError &&
        refreshed.error.kind === "temporary"
      ) {
        return { kind: "unavailable", reason: "temporary" };
      }
      throw refreshed.error;
    }
    const tokens = await encryptAutomaticTokens(
      { contract, token: refreshed.value, fallbackRefreshToken: refreshToken },
      signal,
    );
    return await set(
      publishRefreshedAutomaticCredential$,
      { args, account, token: refreshed.value, tokens },
      signal,
    );
  },
);

function accessTokenRemainsValid(
  expiresAt: Date | null,
  minimumValidityMs: number,
): boolean {
  return (
    expiresAt === null ||
    expiresAt.getTime() > nowDate().getTime() + minimumValidityMs
  );
}

const acceptedCredentialContract$ = command(
  async (
    { set },
    args: ResolveAutomaticCredentialArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly contract: BuiltinAutomaticContract;
    readonly accessName: string;
  } | null> => {
    const db = set(writeDb$);
    const plan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [args.connectorSlug],
    });
    const rows = await db
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    signal.throwIfAborted();
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      plan.selection,
      rows,
    );
    const contract = currentContractFromSnapshot(
      snapshot,
      args.connectorSlug,
      args.authMethodId,
    );
    const accessName = contract && tokenStorageName(contract, "accessToken");
    signal.throwIfAborted();
    if (!contract || !accessName) {
      return null;
    }
    return { contract, accessName };
  },
);

export const resolveBuiltinConnectorAutomaticMcpCredential = command(
  async (
    { set },
    args: ResolveAutomaticCredentialArgs,
    signal: AbortSignal,
  ): Promise<CredentialResult> => {
    const db = set(writeDb$);
    const [account] = await db
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connectorSlug),
          eq(connectors.authMethod, args.authMethodId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!account) {
      return { kind: "unavailable", reason: "reconnect" };
    }
    // A public MCP has no credential contract to validate or refresh.
    if (account.automaticAuthType === "none") {
      return { kind: "none" };
    }
    const accepted = await set(acceptedCredentialContract$, args, signal);
    if (!accepted) {
      return { kind: "unavailable", reason: "stale-contract" };
    }
    const { contract, accessName } = accepted;
    if (account.automaticAuthType !== "oauth" || account.needsReconnect) {
      return { kind: "unavailable", reason: "reconnect" };
    }
    const binding = await set(
      readBuiltinConnectorAutomaticOAuthBinding$,
      account.id,
      signal,
    );
    signal.throwIfAborted();
    if (!binding) {
      return await set(markReconnect$, account.id, signal);
    }
    if (
      binding.registrationMethod === "dcr" &&
      binding.dcrRegistration.expiresAt !== null &&
      binding.dcrRegistration.expiresAt <= nowDate()
    ) {
      await db.execute(
        retireBuiltinDcrRegistrationSql(
          contractOwner(args.orgId, contract),
          binding.dcrRegistration.id,
        ),
      );
      signal.throwIfAborted();
      return { kind: "unavailable", reason: "reconnect" };
    }
    const tokenRows = await db
      .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.connectorId, account.id),
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    const access = tokenRows.find((token) => {
      return token.name === accessName;
    });
    const refresh = tokenRows.find((token) => {
      return token.name === tokenStorageName(contract, "refreshToken");
    });
    if (!access) {
      return await set(markReconnect$, account.id, signal);
    }
    // Providers may omit refresh tokens: use a still-valid access token until expiry.
    if (
      !args.forceRefresh &&
      accessTokenRemainsValid(account.tokenExpiresAt, refresh ? 60_000 : 0)
    ) {
      return {
        kind: "oauth",
        accessToken: await decryptStoredSecretValue(access.encryptedValue),
        tokenExpiresAt: account.tokenExpiresAt,
      };
    }
    if (!refresh) {
      return await set(markReconnect$, account.id, signal);
    }
    return await set(
      refreshAutomatic,
      {
        args,
        contract,
        binding,
        account,
        encryptedRefreshToken: refresh.encryptedValue,
      },
      signal,
    );
  },
);
