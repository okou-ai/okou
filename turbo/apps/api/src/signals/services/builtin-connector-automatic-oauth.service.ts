import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  IssuerMismatchError,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import { AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH } from "@okouai/connectors/connector-catalog/artifacts/mcp-auth";
import { connectors } from "@okouai/db/schema/connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { secrets } from "@okouai/db/schema/secret";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import { writeDb$, type Db } from "../external/db";
import { safeJsonParse, safeSync, settle } from "../utils";
import type { ResolvedConnectorActionMethod } from "./connector-action-resolver.service";
import {
  getConnectorRuntimeMethod,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  replaceConnectorConnection,
  resolveConnectorConnectionMutation,
  type ReadyConnectorConnectionMutation,
} from "./connector-connection-write.service";
import {
  claimConnectorOAuthState,
  insertConnectorOAuthState,
  type StoredBuiltinOAuthState,
} from "./connector-oauth-state.service";
import { upsertConnectorOwnedSecret } from "./connector-credential-storage-write.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  builtinConnectorAutomaticDcrStore,
  lockBuiltinConnectorAutomaticLifecycle,
  type BuiltinConnectorAutomaticContractOwner,
} from "./builtin-connector-automatic-dcr.service";
import {
  McpAutomaticOAuthError,
  exchangeMcpAutomaticOAuthCode,
  isAutomaticOAuthInvalidClient,
  isAutomaticOAuthInvalidGrant,
  prepareMcpAutomaticOAuthAuthorization,
  refreshMcpAutomaticOAuthToken,
  validateMcpAutomaticOAuthCallbackIssuer,
  type McpAutomaticOAuthBinding,
  type McpAutomaticOAuthContext,
  type McpAutomaticOAuthTokenResult,
} from "./mcp-automatic-oauth.service";
import { configuredOkouMcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.service";
import { commitConnectorRuntimeMutation } from "./connector-runtime-wakeup.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";

const httpsUrl = z.url({ protocol: /^https$/u });
const contextBase = z.object({
  version: z.literal(1),
  kind: z.literal("connector-mcp-automatic"),
  connectorSlug: connectorSlugSchema,
  authMethodId: connectorAuthMethodIdSchema,
  storageVersion: z.number().int().positive(),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/u),
  endpoint: httpsUrl,
  reconnectRevision: z.string().nullable(),
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
class StaleBuiltinAutomaticContractError extends Error {}

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
  snapshot: ConnectorRuntimeSnapshot,
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

async function assertCurrentContract(
  db: Db,
  contract: BuiltinAutomaticContract,
): Promise<void> {
  const current = await currentContract(
    db,
    contract.connectorSlug,
    contract.authMethodId,
  );
  if (current?.contractHash !== contract.contractHash) {
    throw new StaleBuiltinAutomaticContractError(
      "Builtin MCP credential contract changed",
    );
  }
}

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
    assertCurrentContract: async (lockedDb) => {
      await assertCurrentContract(lockedDb, contract);
    },
  });
}

function failure(error: unknown): Failure {
  if (error instanceof StaleBuiltinAutomaticContractError) {
    return { kind: "error", reason: "stale-contract" };
  }
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

function revision(mutation: ReadyConnectorConnectionMutation): string | null {
  return mutation.kind === "update" ? mutation.existing.stateRevision : null;
}

async function resolveMutation(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly account: ConnectorAccountMutationIntent;
  },
  contract: BuiltinAutomaticContract,
) {
  return await resolveConnectorConnectionMutation(tx, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: contract.connectorSlug },
    mutation: args.account,
    allowSiblings: true,
  });
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

async function writeTokens(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly contract: BuiltinAutomaticContract;
    readonly token: McpAutomaticOAuthTokenResult;
    readonly fallbackRefreshToken?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const tokens = {
    accessToken: args.token.accessToken,
    refreshToken: args.token.refreshToken ?? args.fallbackRefreshToken,
    idToken: args.token.idToken,
  };
  for (const key of ["accessToken", "refreshToken", "idToken"] as const) {
    const name = tokenStorageName(args.contract, key);
    const value = tokens[key];
    if (!name || !value) {
      continue;
    }
    const encryptedValue = await encryptStoredSecretValue(value);
    signal.throwIfAborted();
    await upsertConnectorOwnedSecret(db, {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      storage: args.contract.method.storage,
      name,
      encryptedValue,
      description: "Automatic MCP OAuth token",
    });
  }
}

async function persistConnection(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly contract: BuiltinAutomaticContract;
    readonly resolution: ReadyConnectorConnectionMutation;
    readonly token?: McpAutomaticOAuthTokenResult;
    readonly context?: McpAutomaticOAuthContext;
  },
  signal: AbortSignal,
): Promise<string> {
  const connection = await replaceConnectorConnection(
    tx,
    {
      orgId: args.orgId,
      userId: args.userId,
      authMethod: args.contract.authMethodId,
      automaticAuthType: args.token ? "oauth" : "none",
      storageVersion: args.contract.storageVersion,
      tokenExpiresAt: args.token?.expiresAt ?? null,
      target: {
        kind: "builtin",
        connectorSlug: args.contract.connectorSlug,
        identity: { kind: "local" },
      },
      resolution: args.resolution,
      writeCredentials: async ({ db, connectorId }, writeSignal) => {
        if (!args.token || !args.context) {
          return;
        }
        await writeTokens(
          db,
          { ...args, connectorId, token: args.token },
          writeSignal,
        );
        const context = args.context;
        await db.insert(builtinConnectorAccountOauthBindings).values({
          connectorAccountId: connectorId,
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: args.contract.connectorSlug,
          authMethod: args.contract.authMethodId,
          storageVersion: args.contract.storageVersion,
          contractHash: args.contract.contractHash,
          endpoint: args.contract.endpoint,
          issuer: context.issuer,
          resource: context.resource,
          resourceMetadataUrl: context.resourceMetadataUrl,
          tokenEndpoint: context.tokenEndpoint,
          clientId: context.clientId,
          tokenEndpointAuthMethod: context.tokenEndpointAuthMethod,
          registrationMethod: context.registrationMethod,
          dcrRegistrationId:
            context.registrationMethod === "dcr"
              ? context.dcrRegistrationId
              : null,
        });
        await db
          .update(connectors)
          .set({
            oauthGrantedScopes:
              args.token.scopes === null
                ? null
                : JSON.stringify(args.token.scopes),
          })
          .where(eq(connectors.id, connectorId));
      },
    },
    signal,
  );
  return connection.id;
}

function builtinAutomaticWakeup(
  db: Db,
  owner: { readonly orgId: string; readonly userId: string },
  connectorSlug: string,
) {
  return {
    db,
    scope: { orgId: owner.orgId, userId: owner.userId },
    targets: [{ kind: "builtin" as const, connectorSlug }],
  };
}

export const startBuiltinConnectorAutomatic$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly resolved: ResolvedConnectorActionMethod;
      readonly account: ConnectorAccountMutationIntent;
      readonly agentId: string | null;
      readonly authorizeAgent: boolean;
      readonly redirectUri: string;
      readonly cimdClientId: string;
      readonly dcrClientMetadata: OAuthClientMetadata;
    },
    signal: AbortSignal,
  ): Promise<
    | Failure
    | {
        readonly kind: "authorization";
        readonly authorizationUrl: string;
        readonly oauthAttemptId: string;
      }
    | { readonly kind: "connected"; readonly connectionId: string }
  > => {
    const db = set(writeDb$);
    const contract = contractFromMethod(
      args.resolved.runtimeMethod,
      args.resolved.catalogConnector.mcp?.endpoint,
    );
    if (!contract) {
      return { kind: "error", reason: "stale-contract" };
    }
    // Treat the commit and its runtime wakeup as one cancellation boundary.
    const operation = await settle(
      commitConnectorRuntimeMutation(
        (async () => {
          await assertCurrentContract(db, contract);
          const preflight = await db.transaction(async (tx) => {
            return await resolveMutation(tx, args, contract);
          });
          if (preflight.kind !== "ready") {
            return { kind: "error", reason: "invalid-account" } as const;
          }
          const reconnectRevision = revision(preflight.mutation);
          const state = generateConnectorOAuthState();
          const prepared = await prepareMcpAutomaticOAuthAuthorization(
            {
              dcrStore: dcrStore(db, args.orgId, contract),
              endpoint: contract.endpoint,
              redirectUri: args.redirectUri,
              state,
              cimdClientId: args.cimdClientId,
              dcrClientMetadata: args.dcrClientMetadata,
            },
            signal,
          );
          return await db.transaction(async (tx) => {
            await lockBuiltinConnectorAutomaticLifecycle(
              tx,
              contractOwner(args.orgId, contract),
            );
            await assertCurrentContract(tx, contract);
            const resolution = await resolveMutation(tx, args, contract);
            if (
              resolution.kind !== "ready" ||
              revision(resolution.mutation) !== reconnectRevision
            ) {
              return { kind: "error", reason: "invalid-account" } as const;
            }
            if (prepared.kind === "none") {
              const connectionId = await persistConnection(
                tx,
                { ...args, contract, resolution: resolution.mutation },
                signal,
              );
              return { kind: "connected", connectionId } as const;
            }
            const context = builtinAutomaticContextSchema.parse({
              ...prepared.context,
              version: 1,
              kind: "connector-mcp-automatic",
              connectorSlug: contract.connectorSlug,
              authMethodId: contract.authMethodId,
              endpoint: contract.endpoint,
              storageVersion: contract.storageVersion,
              contractHash: contract.contractHash,
              reconnectRevision,
            });
            const oauthAttemptId = await insertConnectorOAuthState(tx, {
              state,
              connectorSlug: contract.connectorSlug,
              authMethod: contract.authMethodId,
              storageVersion: null,
              userId: args.userId,
              orgId: args.orgId,
              agentId: args.agentId,
              authorizeAgent: args.authorizeAgent,
              redirectUri: args.redirectUri,
              authorizationUrl: prepared.authorizationUrl,
              codeVerifier: prepared.codeVerifier,
              oauthRequestedScopes: prepared.requestedScope,
              oauthContext: JSON.stringify(context),
              accountMutation: args.account,
              expiresAt: connectorOAuthStateExpiresAt(),
            });
            return {
              kind: "authorization",
              authorizationUrl: prepared.authorizationUrl,
              oauthAttemptId,
            } as const;
          });
        })(),
        (result) => {
          return result.kind === "connected"
            ? builtinAutomaticWakeup(db, args, contract.connectorSlug)
            : undefined;
        },
      ),
      signal,
    );
    if (!operation.ok) {
      return failure(operation.error);
    }
    return operation.value;
  },
);

async function finishAutomaticOAuth(
  db: Db,
  stored: StoredBuiltinOAuthState,
  context: z.infer<typeof builtinAutomaticContextSchema>,
  args: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly issuer: string | undefined;
  },
  signal: AbortSignal,
) {
  const { code, codeVerifier, issuer } = args;
  const contract = await currentContract(
    db,
    stored.connectorSlug,
    stored.authMethod,
  );
  if (
    !contract ||
    contract.contractHash !== context.contractHash ||
    contract.endpoint !== context.endpoint ||
    contract.storageVersion !== context.storageVersion
  ) {
    return { kind: "error", reason: "stale-contract" } as const;
  }
  return await db.transaction(async (tx) => {
    await lockBuiltinConnectorAutomaticLifecycle(
      tx,
      contractOwner(stored.orgId, contract),
    );
    await assertCurrentContract(tx, contract);
    const resolution = await resolveMutation(
      tx,
      {
        orgId: stored.orgId,
        userId: stored.userId,
        account: stored.accountMutation,
      },
      contract,
    );
    if (
      resolution.kind !== "ready" ||
      revision(resolution.mutation) !== context.reconnectRevision
    ) {
      return { kind: "error", reason: "invalid-account" } as const;
    }
    const store = dcrStore(tx, stored.orgId, contract);
    const exchanged = await settle(
      exchangeMcpAutomaticOAuthCode(
        {
          dcrStore: store,
          context,
          redirectUri: stored.redirectUri,
          cimdClientId: configuredOkouMcpOAuthClientMetadata().client_id,
          code,
          iss: issuer,
          codeVerifier,
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
        await store.retire(context.dcrRegistrationId);
      }
      return failure(exchanged.error);
    }
    await assertCurrentContract(tx, contract);
    const connectionId = await persistConnection(
      tx,
      {
        orgId: stored.orgId,
        userId: stored.userId,
        contract,
        resolution: resolution.mutation,
        token: exchanged.value,
        context,
      },
      signal,
    );
    return {
      kind: "connected",
      connectorSlug: stored.connectorSlug,
      connectionId,
      orgId: stored.orgId,
      userId: stored.userId,
      agentId: stored.agentId,
      authorizeAgent: stored.authorizeAgent,
      oauthAttemptId: stored.id,
    } as const;
  });
}

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
  ): Promise<
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
      }
  > => {
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
    const claimed = await claimConnectorOAuthState(
      db,
      {
        state: args.state,
        target: { kind: "builtin", connectorSlug: candidate.connectorSlug },
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
    const operation = await settle(
      commitConnectorRuntimeMutation(
        finishAutomaticOAuth(
          db,
          stored,
          context,
          { code, codeVerifier, issuer: args.issuer },
          signal,
        ),
        (result) => {
          return result.kind === "connected"
            ? builtinAutomaticWakeup(db, stored, stored.connectorSlug)
            : undefined;
        },
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

interface LockedAutomaticCredentialContext {
  readonly contract: BuiltinAutomaticContract;
  readonly accessName: string;
  readonly initialAccessEncrypted: string | undefined;
  readonly accountIdentity: ReturnType<typeof and>;
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

async function refreshLockedAutomatic(
  context: {
    readonly args: ResolveAutomaticCredentialArgs;
    readonly tx: Tx;
    readonly contract: BuiltinAutomaticContract;
    readonly binding: NonNullable<
      Awaited<ReturnType<typeof readBuiltinConnectorAutomaticOAuthBinding>>
    >;
    readonly account: typeof connectors.$inferSelect;
    readonly encryptedRefreshToken: string;
  },
  signal: AbortSignal,
): Promise<CredentialResult> {
  const { args, tx, contract, binding, account, encryptedRefreshToken } =
    context;
  const store = dcrStore(tx, args.orgId, contract);
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
      await store.retire(binding.dcrRegistration.id);
      return { kind: "unavailable", reason: "reconnect" };
    }
    if (
      isAutomaticOAuthInvalidClient(refreshed.error) ||
      isAutomaticOAuthInvalidGrant(refreshed.error) ||
      (refreshed.error instanceof McpAutomaticOAuthError &&
        refreshed.error.kind === "binding-drift")
    ) {
      return await markReconnect(tx, account.id);
    }
    if (
      refreshed.error instanceof McpAutomaticOAuthError &&
      refreshed.error.kind === "temporary"
    ) {
      return { kind: "unavailable", reason: "temporary" };
    }
    throw refreshed.error;
  }
  if (
    !(await credentialDestinationMatches(
      tx,
      contract,
      args.expectedEndpoint,
      signal,
    ))
  ) {
    throw new StaleBuiltinAutomaticContractError(
      "Builtin MCP credential destination changed during refresh",
    );
  }
  await writeTokens(
    tx,
    {
      ...args,
      connectorId: account.id,
      contract,
      token: refreshed.value,
      fallbackRefreshToken: refreshToken,
    },
    signal,
  );
  await tx
    .update(connectors)
    .set({
      tokenExpiresAt: refreshed.value.expiresAt,
      oauthGrantedScopes:
        refreshed.value.scopes === null
          ? account.oauthGrantedScopes
          : JSON.stringify(refreshed.value.scopes),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(connectors.id, account.id));
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

async function resolveLockedAutomatic(
  tx: Tx,
  args: ResolveAutomaticCredentialArgs,
  context: LockedAutomaticCredentialContext,
  signal: AbortSignal,
): Promise<CredentialResult> {
  const { contract, accessName, initialAccessEncrypted, accountIdentity } =
    context;
  await lockBuiltinConnectorAutomaticLifecycle(
    tx,
    contractOwner(args.orgId, contract),
  );
  await lockConnectorAccountTarget(tx, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: args.connectorSlug },
  });
  const [account] = await tx
    .select()
    .from(connectors)
    .where(accountIdentity)
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!account) {
    return { kind: "unavailable", reason: "reconnect" };
  }
  if (account.automaticAuthType === "none") {
    return { kind: "none" };
  }
  // Catalog propagation is best-effort: a request matched by a stale runner
  // catalog must never receive credentials for an endpoint or auth contract that
  // the API no longer accepts for this account connection.
  if (
    !(await credentialDestinationMatches(
      tx,
      contract,
      args.expectedEndpoint,
      signal,
    ))
  ) {
    return { kind: "unavailable", reason: "stale-contract" };
  }
  if (
    account.automaticAuthType !== "oauth" ||
    account.needsReconnect ||
    account.storageVersion !== contract.storageVersion
  ) {
    return { kind: "unavailable", reason: "reconnect" };
  }
  const binding = await readBuiltinConnectorAutomaticOAuthBinding(
    tx,
    account.id,
  );
  if (
    !binding ||
    binding.contractHash !== contract.contractHash ||
    binding.endpoint !== contract.endpoint
  ) {
    return await markReconnect(tx, account.id);
  }
  const store = dcrStore(tx, args.orgId, contract);
  if (
    binding.registrationMethod === "dcr" &&
    binding.dcrRegistration.expiresAt !== null &&
    binding.dcrRegistration.expiresAt <= nowDate()
  ) {
    await store.retire(binding.dcrRegistration.id);
    return { kind: "unavailable", reason: "reconnect" };
  }
  const tokenRows = await tx
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.connectorId, account.id),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
      ),
    );
  const access = tokenRows.find((token) => {
    return token.name === accessName;
  });
  const refresh = tokenRows.find((token) => {
    return token.name === tokenStorageName(contract, "refreshToken");
  });
  if (!access) {
    return await markReconnect(tx, account.id);
  }
  const refreshedSinceInitialRead =
    access.encryptedValue !== initialAccessEncrypted;
  if (
    (!args.forceRefresh || refreshedSinceInitialRead) &&
    accessTokenRemainsValid(account.tokenExpiresAt, 60_000)
  ) {
    return {
      kind: "oauth",
      accessToken: await decryptStoredSecretValue(access.encryptedValue),
      tokenExpiresAt: account.tokenExpiresAt,
    };
  }
  // Providers may omit refresh tokens: use a still-valid access token until expiry.
  if (!refresh) {
    if (
      !args.forceRefresh &&
      accessTokenRemainsValid(account.tokenExpiresAt, 0)
    ) {
      return {
        kind: "oauth",
        accessToken: await decryptStoredSecretValue(access.encryptedValue),
        tokenExpiresAt: account.tokenExpiresAt,
      };
    }
    return await markReconnect(tx, account.id);
  }
  return await refreshLockedAutomatic(
    {
      args,
      tx,
      contract,
      binding,
      account,
      encryptedRefreshToken: refresh.encryptedValue,
    },
    signal,
  );
}

export async function resolveBuiltinConnectorAutomaticMcpCredential(
  args: ResolveAutomaticCredentialArgs,
  signal: AbortSignal,
): Promise<CredentialResult> {
  const accountIdentity = and(
    eq(connectors.id, args.connectorId),
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.connectorSlug, args.connectorSlug),
    eq(connectors.authMethod, args.authMethodId),
  );
  const [initialAccount] = await args.db
    .select({ automaticAuthType: connectors.automaticAuthType })
    .from(connectors)
    .where(accountIdentity)
    .limit(1);
  signal.throwIfAborted();
  if (!initialAccount) {
    return { kind: "unavailable", reason: "reconnect" };
  }
  // A public MCP has no credential contract to validate or lease to refresh.
  if (initialAccount.automaticAuthType === "none") {
    return { kind: "none" };
  }
  const contract = await currentContract(
    args.db,
    args.connectorSlug,
    args.authMethodId,
  );
  if (!contract) {
    return { kind: "unavailable", reason: "stale-contract" };
  }
  const accessName = tokenStorageName(contract, "accessToken");
  if (!accessName) {
    return { kind: "unavailable", reason: "stale-contract" };
  }
  const [initialAccess] = await args.db
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.connectorId, args.connectorId),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, accessName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const resolved = await settle(
    args.db.transaction(async (tx) => {
      return await resolveLockedAutomatic(
        tx,
        args,
        {
          contract,
          accessName,
          initialAccessEncrypted: initialAccess?.encryptedValue,
          accountIdentity,
        },
        signal,
      );
    }),
    signal,
  );
  if (!resolved.ok) {
    if (resolved.error instanceof StaleBuiltinAutomaticContractError) {
      return { kind: "unavailable", reason: "stale-contract" };
    }
    throw resolved.error;
  }
  return resolved.value;
}
