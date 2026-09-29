import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { ConnectorReconnectReason } from "@okouai/api-contracts/contracts/connector-schemas";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "@okouai/connectors/auth-providers";
import { resolveConnectorAuthClient } from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { command } from "ccstate";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  builtinConnectorCredentialSecretReadCondition,
  builtinConnectorCredentialVariableReadCondition,
  resolveBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";
import {
  parseOauthScopes,
  builtinConnectorStoredValueRef,
  storedValueSnapshot,
  decryptCredentialValueSnapshot,
  refreshTokenExpiresAt,
  prepareConnectorRefreshOutputs,
  connectorRefreshInputConditions,
  connectorRefreshStateSelection,
  connectorRefreshStateMatches,
  terminalOAuthRefreshFailure,
  connectorRefreshAccessToken,
  type BuiltinConnectorCredentialConnection,
  type BuiltinConnectorCredentialConnectionResult,
  type BuiltinConnectorStoredValue,
  type PreparedConnectorRefreshOutput,
  type BuiltinConnectorCredentialRefreshResult,
  type BuiltinConnectorRefreshTokenAccess,
} from "./builtin-connector-credential-runtime.service";

const log = logger("api:connector-credential-commands");

interface BuiltinConnectorCredentialCommandRefreshArgs {
  readonly connection: BuiltinConnectorCredentialConnection;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly orgId: string;
  readonly persist?: {
    readonly defaultExpiresInMs?: number;
    readonly markNeedsReconnectOnFailure?: boolean;
  };
  readonly runtimeEnvironmentName: string;
  readonly userId: string;
}

export const loadBuiltinConnectorCredentialConnection$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly connectorSlug: string;
      readonly orgId: string;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly userId: string;
    },
  ): Promise<BuiltinConnectorCredentialConnectionResult> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        authMethod: connectors.authMethod,
        automaticAuthType: connectors.automaticAuthType,
        connectorId: connectors.id,
        externalEmail: connectors.externalEmail,
        externalId: connectors.externalId,
        needsReconnect: connectors.needsReconnect,
        oauthScopes: connectors.oauthScopes,
        oauthGrantedScopes: connectors.oauthGrantedScopes,
        stateRevision: sql`${connectors.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connectorSlug),
        ),
      )
      .limit(1);
    if (!row) {
      return { kind: "missing" };
    }
    const accessResult = resolveBuiltinConnectorCredentialAccess({
      snapshot: args.snapshot,
      stored: {
        authMethodId: row.authMethod,
        automaticAuthType: row.automaticAuthType,
        connectorId: row.connectorId,
        connectorSlug: args.connectorSlug,
        orgId: args.orgId,
        storageVersion: row.storageVersion,
        userId: args.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return { kind: "unavailable" };
    }
    const { access } = accessResult;
    return {
      kind: "ok",
      connection: {
        access,
        connectorId: row.connectorId,
        connectorSlug: args.connectorSlug,
        externalEmail: row.externalEmail,
        externalId: row.externalId,
        needsReconnect: row.needsReconnect,
        oauthScopes: parseOauthScopes(row.oauthGrantedScopes),
        runtimeMethod: access.runtimeMethod,
        stateRevision: row.stateRevision,
        storageVersion: access.storageVersion,
        tokenExpiresAt: row.tokenExpiresAt,
      },
    };
  },
);

const loadBuiltinConnectorStoredValues$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly featureSwitchContext?: FeatureSwitchContext;
      readonly valueRefs: readonly string[];
    },
  ): Promise<ReadonlyMap<string, BuiltinConnectorStoredValue>> => {
    const db = set(writeDb$);
    const refs = args.valueRefs.map(builtinConnectorStoredValueRef);
    const secretNames = refs.flatMap((ref) => {
      return ref.kind === "secret" ? [ref.name] : [];
    });
    const variableNames = refs.flatMap((ref) => {
      return ref.kind === "variable" ? [ref.name] : [];
    });
    if (secretNames.length === 0 && variableNames.length === 0) {
      return new Map();
    }
    const secretQuery = db
      .select({
        kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
        name: secrets.name,
        value: secrets.encryptedValue,
      })
      .from(secrets)
      .where(
        builtinConnectorCredentialSecretReadCondition({
          groups: [
            {
              access: args.connection.access,
              names: secretNames,
            },
          ],
        }),
      );
    const variableQuery = db
      .select({
        kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
        name: variables.name,
        value: variables.value,
      })
      .from(variables)
      .where(
        builtinConnectorCredentialVariableReadCondition({
          groups: [
            {
              access: args.connection.access,
              names: variableNames,
            },
          ],
        }),
      );
    // A single statement snapshot prevents same-contract replacement from
    // combining a secret from one stored state with a variable from another.
    const rows = await secretQuery.unionAll(variableQuery);
    return storedValueSnapshot(rows);
  },
);

export const loadBuiltinConnectorCredentialValues$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly featureSwitchContext?: FeatureSwitchContext;
      readonly valueRefs: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> => {
    const snapshot = await set(loadBuiltinConnectorStoredValues$, args);
    signal.throwIfAborted();
    const values = await decryptCredentialValueSnapshot(
      snapshot,
      args.featureSwitchContext,
    );
    signal.throwIfAborted();
    return values;
  },
);

function refreshTokenAccess(connection: BuiltinConnectorCredentialConnection) {
  const access = connection.runtimeMethod.method.access;
  if (access.kind !== "refresh-token") {
    throw new Error("Connector credential is not refreshable");
  }
  return access;
}

const commitConnectorRefresh$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly inputSnapshot: ReadonlyMap<string, BuiltinConnectorStoredValue>;
      readonly orgId: string;
      readonly userId: string;
      readonly scopes: readonly string[] | undefined;
      readonly prepared: readonly PreparedConnectorRefreshOutput[];
      readonly tokenExpiresAt: Date | null;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "ok"; readonly tokenExpiresAt: Date | null }
    | { readonly kind: "connection-changed" }
  > => {
    const db = set(writeDb$);
    const access = refreshTokenAccess(args.connection);
    const inputRefs = Object.values(access.inputs);
    const { secretCondition, variableCondition } =
      connectorRefreshInputConditions({ access, connection: args.connection });
    const result = await db.transaction(async (tx) => {
      // Outgoing account replacement/deletion still uses this coordinator.
      // Retire it only when those writers share the conditional storage protocol.
      await tx.execute(
        builtinConnectorStateLockStatement({
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: args.connection.connectorSlug,
        }),
      );
      signal.throwIfAborted();
      const [currentConnector] = await tx
        .select(connectorRefreshStateSelection())
        .from(connectors)
        .where(
          and(
            eq(connectors.id, args.connection.connectorId),
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, args.connection.connectorSlug),
          ),
        )
        .for("update")
        .limit(1);
      if (!connectorRefreshStateMatches(currentConnector, args.connection)) {
        return { kind: "connection-changed" } as const;
      }
      const secretQuery = tx
        .select({
          kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
          name: secrets.name,
          value: secrets.encryptedValue,
        })
        .from(secrets)
        .where(secretCondition);
      const variableQuery = tx
        .select({
          kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
          name: variables.name,
          value: variables.value,
        })
        .from(variables)
        .where(variableCondition);
      const currentInputs = storedValueSnapshot(
        await secretQuery.unionAll(variableQuery),
      );
      for (const valueRef of inputRefs) {
        if (
          currentInputs.get(valueRef)?.storedValue !==
          args.inputSnapshot.get(valueRef)?.storedValue
        ) {
          return { kind: "connection-changed" } as const;
        }
      }
      for (const output of args.prepared) {
        const identity = {
          connectorId: args.connection.connectorId,
          orgId: args.orgId,
          userId: args.userId,
          name: output.name,
          type: "connector",
        };
        if (output.kind === "secret") {
          await tx
            .insert(secrets)
            .values({
              ...identity,
              encryptedValue: output.encryptedValue,
              description: `Connector token output for ${args.connection.connectorSlug}: ${output.name}`,
            })
            .onConflictDoUpdate({
              target: [secrets.connectorId, secrets.name],
              targetWhere: isNotNull(secrets.connectorId),
              set: {
                encryptedValue: output.encryptedValue,
                updatedAt: nowDate(),
              },
            });
        } else {
          await tx
            .insert(variables)
            .values({ ...identity, value: output.value, description: null })
            .onConflictDoUpdate({
              target: [variables.connectorId, variables.name],
              targetWhere: isNotNull(variables.connectorId),
              set: { value: output.value, updatedAt: nowDate() },
            });
        }
      }
      await tx
        .update(connectors)
        .set({
          ...(args.scopes === undefined
            ? {}
            : { oauthGrantedScopes: JSON.stringify(args.scopes) }),
          tokenExpiresAt: args.tokenExpiresAt,
          storageVersion: args.connection.runtimeMethod.method.storage.version,
          needsReconnect: false,
          reconnectReason: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(connectors.id, args.connection.connectorId));
      return { kind: "ok", tokenExpiresAt: args.tokenExpiresAt } as const;
    });
    signal.throwIfAborted();
    return result;
  },
);

const markConnectorCredentialNeedsReconnectAfterRefreshFailure$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly orgId: string;
      readonly reconnectReason: ConnectorReconnectReason | null;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [row] = await db
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: args.reconnectReason,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(connectors.id, args.connection.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connection.connectorSlug),
          eq(connectors.authMethod, args.connection.runtimeMethod.authMethodId),
          eq(sql`${connectors.updatedAt}::text`, args.connection.stateRevision),
        ),
      )
      .returning({ id: connectors.id });
    signal.throwIfAborted();
    return row !== undefined;
  },
);

const terminalConnectorCredentialRefreshFailure$ = command(
  async (
    { set },
    args: BuiltinConnectorCredentialCommandRefreshArgs,
    error: unknown,
    signal: AbortSignal,
  ): Promise<BuiltinConnectorCredentialRefreshResult | null> => {
    const terminalFailure = terminalOAuthRefreshFailure(error);
    if (terminalFailure === null) {
      return null;
    }
    if (!args.persist) {
      return { kind: "reconnect-required" };
    }
    const updated = await set(
      markConnectorCredentialNeedsReconnectAfterRefreshFailure$,
      {
        connection: args.connection,
        orgId: args.orgId,
        reconnectReason: terminalFailure.reconnectReason,
        userId: args.userId,
      },
      signal,
    );
    return updated
      ? { kind: "reconnect-required" }
      : { kind: "connection-changed" };
  },
);

const connectorCredentialRefreshFailure$ = command(
  async (
    { set },
    args: BuiltinConnectorCredentialCommandRefreshArgs,
    kind: "invalid-output" | "missing-input" | "provider-failed",
    signal: AbortSignal,
  ): Promise<BuiltinConnectorCredentialRefreshResult> => {
    if (args.persist?.markNeedsReconnectOnFailure === true) {
      await set(
        markConnectorCredentialNeedsReconnectAfterRefreshFailure$,
        {
          connection: args.connection,
          orgId: args.orgId,
          reconnectReason: null,
          userId: args.userId,
        },
        signal,
      );
    }
    return { kind };
  },
);

const loadConnectorRefreshInputs$ = command(
  async (
    { set },
    args: BuiltinConnectorCredentialCommandRefreshArgs,
    access: BuiltinConnectorRefreshTokenAccess,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly inputs: Readonly<Record<string, string>>;
        readonly snapshot: ReadonlyMap<string, BuiltinConnectorStoredValue>;
      }
    | { readonly kind: "missing-input" }
  > => {
    const snapshot = await set(loadBuiltinConnectorStoredValues$, {
      connection: args.connection,
      valueRefs: Object.values(access.inputs),
      ...(args.featureSwitchContext === undefined
        ? {}
        : { featureSwitchContext: args.featureSwitchContext }),
    });
    const inputValues = await decryptCredentialValueSnapshot(
      snapshot,
      args.featureSwitchContext,
    );
    const inputs: Record<string, string> = {};
    for (const [inputName, valueRef] of Object.entries(access.inputs)) {
      const value = inputValues.get(valueRef);
      if (value === undefined) {
        return { kind: "missing-input" };
      }
      inputs[inputName] = value;
    }
    return { kind: "ok", inputs, snapshot };
  },
);

const persistConnectorRefresh$ = command(
  async (
    { set },
    args: {
      readonly connection: BuiltinConnectorCredentialConnection;
      readonly defaultExpiresInMs?: number;
      readonly inputSnapshot: ReadonlyMap<string, BuiltinConnectorStoredValue>;
      readonly orgId: string;
      readonly outputs: Readonly<Record<string, string | undefined>>;
      readonly scopes?: readonly string[];
      readonly userId: string;
      readonly expiresIn: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "ok"; readonly tokenExpiresAt: Date | null }
    | { readonly kind: "connection-changed" }
  > => {
    const access = refreshTokenAccess(args.connection);
    const tokenExpiresAt = refreshTokenExpiresAt(
      args.expiresIn,
      args.defaultExpiresInMs,
    );
    const prepared = await prepareConnectorRefreshOutputs(
      { access, connection: args.connection, outputs: args.outputs },
      signal,
    );
    return await set(
      commitConnectorRefresh$,
      {
        connection: args.connection,
        inputSnapshot: args.inputSnapshot,
        orgId: args.orgId,
        userId: args.userId,
        scopes: args.scopes,
        prepared,
        tokenExpiresAt,
      },
      signal,
    );
  },
);

export const refreshBuiltinConnectorCredentialAccess$ = command(
  async (
    { set },
    args: BuiltinConnectorCredentialCommandRefreshArgs,
    signal: AbortSignal,
  ): Promise<BuiltinConnectorCredentialRefreshResult> => {
    if (
      args.connection.storageVersion !==
      args.connection.runtimeMethod.method.storage.version
    ) {
      return { kind: "connection-changed" };
    }
    const access = args.connection.runtimeMethod.method.access;
    if (access.kind !== "refresh-token") {
      return { kind: "not-refreshable" };
    }
    const authClient = args.connection.runtimeMethod.method.client
      ? resolveConnectorAuthClient(
          args.connection.runtimeMethod.method.client,
          optionalEnv,
        )
      : undefined;
    if (args.connection.runtimeMethod.method.client && !authClient) {
      return { kind: "configuration-unavailable" };
    }
    const loadedInputs = await set(loadConnectorRefreshInputs$, args, access);
    signal.throwIfAborted();
    if (loadedInputs.kind === "missing-input") {
      return await set(
        connectorCredentialRefreshFailure$,
        args,
        "missing-input",
        signal,
      );
    }
    const refreshed = await settleIncludingAbort(
      refreshConnectorAuthProviderAccessTokenWithMethod(
        {
          connectorSlug: args.connection.runtimeMethod.connectorSlug,
          authMethodId: args.connection.runtimeMethod.authMethodId,
          method: args.connection.runtimeMethod.method,
          ...(authClient === undefined ? {} : { authClient }),
          inputs: loadedInputs.inputs,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!refreshed.ok) {
      const terminalFailure = await set(
        terminalConnectorCredentialRefreshFailure$,
        args,
        refreshed.error,
        signal,
      );
      if (terminalFailure !== null) {
        return terminalFailure;
      }
      // A reconnect-required failure is already visible as persisted connection
      // state; only an upstream provider failure writes one warn.
      log.warn("Connector credential refresh failed", {
        connectorSlug: args.connection.connectorSlug,
        authMethodId: args.connection.runtimeMethod.authMethodId,
        orgId: args.orgId,
        userId: args.userId,
      });
      return await set(
        connectorCredentialRefreshFailure$,
        args,
        "provider-failed",
        signal,
      );
    }
    const accessToken = connectorRefreshAccessToken({
      access,
      connection: args.connection,
      outputs: refreshed.value.outputs,
      runtimeEnvironmentName: args.runtimeEnvironmentName,
    });
    if (accessToken === null) {
      return await set(
        connectorCredentialRefreshFailure$,
        args,
        "invalid-output",
        signal,
      );
    }
    const persisted = args.persist
      ? await set(
          persistConnectorRefresh$,
          {
            connection: args.connection,
            inputSnapshot: loadedInputs.snapshot,
            orgId: args.orgId,
            outputs: refreshed.value.outputs,
            userId: args.userId,
            expiresIn: refreshed.value.expiresIn,
            ...(refreshed.value.scopes === undefined
              ? {}
              : { scopes: refreshed.value.scopes }),
            ...(args.persist.defaultExpiresInMs === undefined
              ? {}
              : { defaultExpiresInMs: args.persist.defaultExpiresInMs }),
          },
          signal,
        )
      : {
          kind: "ok" as const,
          tokenExpiresAt: refreshTokenExpiresAt(
            refreshed.value.expiresIn,
            undefined,
          ),
        };
    if (persisted.kind === "connection-changed") {
      // Same-account reconnect preserves the account, method and storage identity.
      // A newer usable credential therefore does not prove a concurrent refresh:
      // this request must not inherit an authorization that replaced its snapshot.
      return { kind: "connection-changed" };
    }
    return {
      kind: "ok",
      accessToken,
      tokenExpiresAt: persisted.tokenExpiresAt,
    };
  },
);
