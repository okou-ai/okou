import {
  IssuerMismatchError,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import { AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH } from "@okouai/connectors/connector-catalog/artifacts/mcp-auth";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import { connectors } from "@okouai/db/schema/connector";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { secrets } from "@okouai/db/schema/secret";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, safeSync, settle } from "../utils";
import {
  automaticAccountExists$,
  publishAutomaticConnection$,
  type AutomaticConnectionPublication,
} from "./builtin-connector-automatic-connection.service";
import {
  builtinConnectorAutomaticDcrStore,
  createBuiltinDcrRegistration$,
  hasBuiltinDcrLinkedAccounts$,
  readBuiltinDcrBoundClient$,
  readBuiltinDcrRegistrationByIssuer$,
  retireBuiltinDcrRegistration$,
  type BuiltinConnectorAutomaticContractOwner,
} from "./builtin-connector-automatic-dcr.service";
import type { ResolvedConnectorActionMethod } from "./connector-action-resolver.service";
import {
  immutableConnectorRuntimeSelection,
  type ImmutableConnectorRuntimeSelection,
} from "./connector-catalog-entries.service";
import {
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeLookup,
} from "./connector-catalog-runtime.service";
import { upsertConnectorOwnedSecret } from "./connector-credential-storage-write.service";
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
  storageVersion: z.number().int().positive(),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/u),
  endpoint: httpsUrl,
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
  contextBase
    .extend({
      registrationMethod: z.literal("cimd"),
      tokenEndpointAuthMethod: z.literal("none"),
    })
    .strict(),
  contextBase
    .extend({
      registrationMethod: z.literal("dcr"),
      dcrRegistrationId: z.uuid(),
    })
    .strict(),
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
  readonly contractHash: string;
  readonly method: BuiltinAutomaticMethod;
}
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
  const contractHash = createHash("sha256")
    .update(
      JSON.stringify({
        endpoint,
        authMethodId,
        storage: method.storage,
        grant: method.grant,
        access: method.access,
      }),
    )
    .digest("hex");
  return {
    connectorSlug,
    authMethodId,
    endpoint,
    storageVersion: method.storage.version,
    contractHash,
    method: {
      storage: method.storage,
      grant: method.grant,
      access: method.access,
      revoke: { kind: "none" },
    },
  };
}

function currentContractFromSnapshot(
  snapshot: ConnectorRuntimeLookup,
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

async function currentContract(
  db: Db,
  connectorSlug: string,
  authMethodId: string,
): Promise<BuiltinAutomaticContract | null> {
  return currentContractFromSnapshot(
    await loadConnectorRuntimeSnapshot(db),
    connectorSlug,
    authMethodId,
  );
}

const currentBuiltinAutomaticContract$ = command(
  async (
    { get },
    args: { readonly connectorSlug: string; readonly authMethodId: string },
    signal: AbortSignal,
  ): Promise<BuiltinAutomaticContract | null> => {
    const snapshot = await get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [
          connectorSlugSchema.parse(args.connectorSlug),
        ],
      }),
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
    contractHash: contract.contractHash,
  };
}

function dcrStore(db: Db, orgId: string, contract: BuiltinAutomaticContract) {
  return builtinConnectorAutomaticDcrStore({
    db,
    owner: contractOwner(orgId, contract),
  });
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

async function writeEncryptedTokens(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly contract: BuiltinAutomaticContract;
    readonly tokens: readonly EncryptedAutomaticToken[];
  },
): Promise<void> {
  for (const token of args.tokens) {
    await upsertConnectorOwnedSecret(db, {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      storage: args.contract.method.storage,
      name: token.name,
      encryptedValue: token.encryptedValue,
      description: "Automatic MCP OAuth token",
    });
  }
}

const prepareBuiltinAutomaticAuthorization$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly contract: BuiltinAutomaticContract;
      readonly catalogIdentity: ImmutableConnectorRuntimeSelection["catalogIdentity"];
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
                catalogIdentity: args.catalogIdentity,
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
  readonly resolved: ResolvedConnectorActionMethod<ImmutableConnectorRuntimeSelection>;
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
          catalogIdentity: args.resolved.snapshot.catalogIdentity,
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
      endpoint: contract.endpoint,
      storageVersion: contract.storageVersion,
      contractHash: contract.contractHash,
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
      contractHash: contract.contractHash,
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
    if (
      !contract ||
      contract.contractHash !== context.contractHash ||
      contract.endpoint !== context.endpoint ||
      contract.storageVersion !== context.storageVersion
    ) {
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

async function readBuiltinConnectorAutomaticOAuthBinding(
  db: Db,
  connectorId: string,
): Promise<
  | (McpAutomaticOAuthBinding & {
      readonly endpoint: string;
      readonly contractHash: string;
    })
  | null
> {
  const [row] = await db
    .select({
      binding: builtinConnectorAccountOauthBindings,
      account: {
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
        automaticAuthType: connectors.automaticAuthType,
      },
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
  if (
    !row ||
    row.account.automaticAuthType !== "oauth" ||
    row.account.authMethod !== row.binding.authMethod ||
    row.account.storageVersion !== row.binding.storageVersion
  ) {
    return null;
  }
  const binding = row.binding;
  if (binding.registrationMethod === "cimd") {
    return binding.tokenEndpointAuthMethod === "none" &&
      binding.dcrRegistrationId === null
      ? { ...binding, registrationMethod: "cimd", dcrRegistration: null }
      : null;
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
        eq(builtinConnectorDcrRegistrations.contractHash, binding.contractHash),
        eq(builtinConnectorDcrRegistrations.issuer, binding.issuer),
      ),
    )
    .limit(1);
  const registration = storedRegistration
    ? {
        ...storedRegistration,
        hasClientSecret: storedRegistration.encryptedClientSecret !== null,
      }
    : null;
  if (
    !registration ||
    registration.id !== binding.dcrRegistrationId ||
    registration.clientId !== binding.clientId ||
    registration.tokenEndpointAuthMethod !== binding.tokenEndpointAuthMethod
  ) {
    return null;
  }
  return {
    ...binding,
    registrationMethod: "dcr",
    dcrRegistration: registration,
  };
}

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
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly expectedEndpoint: string | undefined;
  readonly forceRefresh?: boolean;
}

async function markReconnect(
  db: Db,
  connectorId: string,
): Promise<CredentialResult> {
  await db
    .update(connectors)
    .set({
      needsReconnect: true,
      reconnectReason: "authorization_expired_or_revoked",
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(connectors.id, connectorId));
  return { kind: "unavailable", reason: "reconnect" };
}

/**
 * Provider refresh runs outside any transaction; one short transaction then
 * writes the refreshed tokens and account metadata.
 */
async function refreshAutomatic(
  context: {
    readonly args: ResolveAutomaticCredentialArgs;
    readonly contract: BuiltinAutomaticContract;
    readonly binding: NonNullable<
      Awaited<ReturnType<typeof readBuiltinConnectorAutomaticOAuthBinding>>
    >;
    readonly account: typeof connectors.$inferSelect;
    readonly encryptedRefreshToken: string;
  },
  signal: AbortSignal,
): Promise<CredentialResult> {
  const { args, contract, binding, account, encryptedRefreshToken } = context;
  const store = dcrStore(args.db, args.orgId, contract);
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
        dcrStore: store,
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
      await args.db.transaction(async (tx) => {
        await dcrStore(tx, args.orgId, contract).retire(
          binding.dcrRegistration.id,
        );
      });
      return { kind: "unavailable", reason: "reconnect" };
    }
    if (
      isAutomaticOAuthInvalidClient(refreshed.error) ||
      isAutomaticOAuthInvalidGrant(refreshed.error) ||
      (refreshed.error instanceof McpAutomaticOAuthError &&
        refreshed.error.kind === "binding-drift")
    ) {
      return await markReconnect(args.db, account.id);
    }
    if (
      refreshed.error instanceof McpAutomaticOAuthError &&
      refreshed.error.kind === "temporary"
    ) {
      return { kind: "unavailable", reason: "temporary" };
    }
    throw refreshed.error;
  }
  const identity = resolveRefreshedOAuthIdentity(
    {
      externalId: account.externalId,
      externalUsername: account.externalUsername,
      externalEmail: account.externalEmail,
    },
    refreshed.value.userInfo,
  );
  if (identity.kind === "mismatch") {
    return await markReconnect(args.db, account.id);
  }
  const tokens = await encryptAutomaticTokens(
    { contract, token: refreshed.value, fallbackRefreshToken: refreshToken },
    signal,
  );
  await args.db.transaction(async (tx) => {
    await writeEncryptedTokens(tx, {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: account.id,
      contract,
      tokens,
    });
    await tx
      .update(connectors)
      .set({
        tokenExpiresAt: refreshed.value.expiresAt,
        oauthGrantedScopes:
          refreshed.value.scopes === null
            ? account.oauthGrantedScopes
            : JSON.stringify(refreshed.value.scopes),
        ...(identity.kind === "update"
          ? {
              externalId: identity.externalId,
              externalUsername: identity.externalUsername,
              externalEmail: identity.externalEmail,
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, account.id));
  });
  return {
    kind: "oauth",
    accessToken: refreshed.value.accessToken,
    tokenExpiresAt: refreshed.value.expiresAt,
  };
}

function accessTokenRemainsValid(
  expiresAt: Date | null,
  minimumValidityMs: number,
): boolean {
  return (
    expiresAt === null ||
    expiresAt.getTime() > nowDate().getTime() + minimumValidityMs
  );
}

async function credentialDestinationMatches(
  db: Db,
  contract: BuiltinAutomaticContract,
  expectedEndpoint: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (expectedEndpoint !== contract.endpoint) {
    return false;
  }
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  const current = currentContractFromSnapshot(
    snapshot,
    contract.connectorSlug,
    contract.authMethodId,
  );
  const currentCatalogApi = snapshot.serverFirewalls
    .getRuntimeFirewall(contract.connectorSlug)
    ?.apis.find((api) => {
      return api.base === expectedEndpoint;
    });
  signal.throwIfAborted();
  return (
    current?.contractHash === contract.contractHash &&
    isDeepStrictEqual(
      currentCatalogApi?.auth,
      AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH,
    )
  );
}

/**
 * Catalog propagation is best-effort: a request matched by a stale runner
 * catalog must never receive credentials for an endpoint or auth contract that
 * the API no longer accepts for this account connection.
 */
async function acceptedCredentialContract(
  args: ResolveAutomaticCredentialArgs,
  signal: AbortSignal,
): Promise<{
  readonly contract: BuiltinAutomaticContract;
  readonly accessName: string;
} | null> {
  const contract = await currentContract(
    args.db,
    args.connectorSlug,
    args.authMethodId,
  );
  const accessName = contract && tokenStorageName(contract, "accessToken");
  if (
    !contract ||
    !accessName ||
    !(await credentialDestinationMatches(
      args.db,
      contract,
      args.expectedEndpoint,
      signal,
    ))
  ) {
    return null;
  }
  return { contract, accessName };
}

export async function resolveBuiltinConnectorAutomaticMcpCredential(
  args: ResolveAutomaticCredentialArgs,
  signal: AbortSignal,
): Promise<CredentialResult> {
  const { db } = args;
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
  const accepted = await acceptedCredentialContract(args, signal);
  if (!accepted) {
    return { kind: "unavailable", reason: "stale-contract" };
  }
  const { contract, accessName } = accepted;
  if (
    account.automaticAuthType !== "oauth" ||
    account.needsReconnect ||
    account.storageVersion !== contract.storageVersion
  ) {
    return { kind: "unavailable", reason: "reconnect" };
  }
  const binding = await readBuiltinConnectorAutomaticOAuthBinding(
    db,
    account.id,
  );
  if (
    !binding ||
    binding.contractHash !== contract.contractHash ||
    binding.endpoint !== contract.endpoint
  ) {
    return await markReconnect(db, account.id);
  }
  if (
    binding.registrationMethod === "dcr" &&
    binding.dcrRegistration.expiresAt !== null &&
    binding.dcrRegistration.expiresAt <= nowDate()
  ) {
    await db.transaction(async (tx) => {
      await dcrStore(tx, args.orgId, contract).retire(
        binding.dcrRegistration.id,
      );
    });
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
    return await markReconnect(db, account.id);
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
    return await markReconnect(db, account.id);
  }
  return await refreshAutomatic(
    {
      args,
      contract,
      binding,
      account,
      encryptedRefreshToken: refresh.encryptedValue,
    },
    signal,
  );
}
