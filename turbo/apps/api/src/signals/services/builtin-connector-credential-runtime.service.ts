import { isTransientOAuthRefreshFailure } from "./oauth-refresh-failure.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { ConnectorReconnectReason } from "@okouai/api-contracts/contracts/connector-schemas";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "@okouai/connectors/auth-providers";
import { isOAuthProviderHttpError } from "@okouai/connectors/auth-providers/oauth/error";
import { resolveConnectorAuthClient } from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import type {
  ConnectorRuntimeMethod,
  ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import {
  builtinConnectorCredentialSecretReadCondition,
  builtinConnectorCredentialVariableReadCondition,
  resolveBuiltinConnectorCredentialAccess,
  type BuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";

const log = logger("api:connector-credential-runtime");
const oauthScopesSchema = z.array(z.string());

export interface BuiltinConnectorCredentialConnection {
  readonly access: BuiltinConnectorCredentialAccess;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly externalEmail: string | null;
  readonly externalId: string | null;
  readonly needsReconnect: boolean;
  readonly oauthScopes: readonly string[] | null;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly stateRevision: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
}

export type BuiltinConnectorCredentialConnectionResult =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ok";
      readonly connection: BuiltinConnectorCredentialConnection;
    };

interface BuiltinConnectorStoredValueRef {
  readonly kind: "secret" | "variable";
  readonly name: string;
  readonly valueRef: string;
}

type PreparedConnectorRefreshOutput =
  | {
      readonly kind: "secret";
      readonly name: string;
      readonly encryptedValue: string;
    }
  | {
      readonly kind: "variable";
      readonly name: string;
      readonly value: string;
    };

export type BuiltinConnectorCredentialRefreshResult =
  | {
      readonly kind: "ok";
      readonly accessToken: string;
      readonly tokenExpiresAt: Date | null;
    }
  | {
      readonly kind:
        | "connection-changed"
        | "configuration-unavailable"
        | "invalid-output"
        | "missing-input"
        | "not-refreshable"
        | "provider-failed"
        | "reconnect-required";
    };

interface BuiltinConnectorCredentialRefreshArgs {
  readonly connection: BuiltinConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly orgId: string;
  readonly persist?: {
    readonly db: Db;
    readonly defaultExpiresInMs?: number;
    readonly markNeedsReconnectOnFailure?: boolean;
  };
  readonly runtimeEnvironmentName: string;
  readonly userId: string;
}

type BuiltinConnectorRefreshTokenAccess = Extract<
  ConnectorRuntimeMethod["method"]["access"],
  { readonly kind: "refresh-token" }
>;

interface TerminalOAuthRefreshFailure {
  readonly reconnectReason: ConnectorReconnectReason | null;
}

function parseOauthScopes(value: string | null): readonly string[] | null {
  return value === null ? null : oauthScopesSchema.parse(JSON.parse(value));
}

function builtinConnectorStoredValueRef(
  valueRef: string,
): BuiltinConnectorStoredValueRef {
  if (valueRef.startsWith("$secrets.")) {
    return {
      kind: "secret",
      name: valueRef.slice("$secrets.".length),
      valueRef,
    };
  }
  if (valueRef.startsWith("$vars.")) {
    return {
      kind: "variable",
      name: valueRef.slice("$vars.".length),
      valueRef,
    };
  }
  throw new Error("Invalid connector stored value reference");
}

export async function loadBuiltinConnectorCredentialConnection(args: {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly snapshot: ConnectorRuntimeSelection;
  readonly userId: string;
}): Promise<BuiltinConnectorCredentialConnectionResult> {
  const [row] = await args.db
    .select({
      authMethod: connectors.authMethod,
      automaticAuthType: connectors.automaticAuthType,
      connectorId: connectors.id,
      externalEmail: connectors.externalEmail,
      externalId: connectors.externalId,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      oauthGrantedScopes: connectors.oauthGrantedScopes,
      stateRevision: sql`${connectors.updatedAt}::text`.mapWith(pgTextDecoder),
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
}

export function builtinConnectorCredentialRuntimeValueRef(
  connection: BuiltinConnectorCredentialConnection,
  environmentName: string,
): string | null {
  const access = connection.runtimeMethod.method.access;
  if (access.kind === "none" || access.kind === "automatic") {
    return null;
  }
  const binding = access.envBindings[environmentName];
  if (binding === undefined) {
    return null;
  }
  return typeof binding === "string" ? binding : binding.valueRef;
}

export async function loadBuiltinConnectorCredentialValues(args: {
  readonly connection: BuiltinConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly valueRefs: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
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
  const secretQuery = args.db
    .select({
      kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
      name: secrets.name,
      value: secrets.encryptedValue,
    })
    .from(secrets)
    .where(
      builtinConnectorCredentialSecretReadCondition({
        groups: [{ access: args.connection.access, names: secretNames }],
      }),
    );
  const variableQuery = args.db
    .select({
      kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
      name: variables.name,
      value: variables.value,
    })
    .from(variables)
    .where(
      builtinConnectorCredentialVariableReadCondition({
        groups: [{ access: args.connection.access, names: variableNames }],
      }),
    );
  const rows = await secretQuery.unionAll(variableQuery);
  const values = new Map<string, string>();
  for (const row of rows) {
    switch (row.kind) {
      case "secret": {
        values.set(
          `$secrets.${row.name}`,
          await decryptStoredSecretValue(row.value, args.featureSwitchContext),
        );
        break;
      }
      case "variable": {
        values.set(`$vars.${row.name}`, row.value);
        break;
      }
      default: {
        throw new Error("Invalid connector credential value kind");
      }
    }
  }
  return values;
}

function refreshTokenExpiresAt(
  expiresIn: number | undefined,
  defaultExpiresInMs: number | undefined,
): Date | null {
  if (expiresIn !== undefined) {
    return new Date(nowDate().getTime() + expiresIn * 1000);
  }
  return defaultExpiresInMs === undefined
    ? null
    : new Date(nowDate().getTime() + defaultExpiresInMs);
}

async function prepareConnectorRefreshOutputs(
  args: {
    readonly access: BuiltinConnectorRefreshTokenAccess;
    readonly connection: BuiltinConnectorCredentialConnection;
    readonly outputs: Readonly<Record<string, string | undefined>>;
  },
  signal: AbortSignal,
): Promise<readonly PreparedConnectorRefreshOutput[]> {
  const prepared: PreparedConnectorRefreshOutput[] = [];
  for (const [outputName, value] of Object.entries(args.outputs)) {
    if (value === undefined) {
      continue;
    }
    const valueRef = args.access.outputs[outputName];
    if (valueRef === undefined) {
      throw new Error("Connector refresh returned an undeclared output");
    }
    const target = builtinConnectorStoredValueRef(valueRef);
    prepared.push(
      target.kind === "secret"
        ? {
            kind: "secret",
            name: target.name,
            encryptedValue: await encryptStoredSecretValue(value),
          }
        : { kind: "variable", name: target.name, value },
    );
    signal.throwIfAborted();
  }
  return prepared;
}

function connectorOwnershipCondition(args: {
  readonly connection: BuiltinConnectorCredentialConnection;
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(connectors.id, args.connection.connectorId),
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.connectorSlug, args.connection.connectorSlug),
  );
}

/**
 * Plainly writes refreshed tokens for the owned account. Concurrent refreshes
 * are last-writer-wins; a lost rotation surfaces as a reconnect.
 */
async function persistConnectorRefresh(
  args: {
    readonly connection: BuiltinConnectorCredentialConnection;
    readonly db: Db;
    readonly defaultExpiresInMs?: number;
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
> {
  const access = args.connection.runtimeMethod.method.access;
  if (access.kind !== "refresh-token") {
    throw new Error("Connector credential is not refreshable");
  }
  const tokenExpiresAt = refreshTokenExpiresAt(
    args.expiresIn,
    args.defaultExpiresInMs,
  );
  // Encryption may call KMS, so it runs before the transaction opens.
  const prepared = await prepareConnectorRefreshOutputs(
    { access, connection: args.connection, outputs: args.outputs },
    signal,
  );
  const storage = args.connection.runtimeMethod.method.storage;
  const persisted = await args.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(connectors)
      .set({
        ...(args.scopes === undefined
          ? {}
          : { oauthGrantedScopes: JSON.stringify(args.scopes) }),
        tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(connectorOwnershipCondition(args))
      .returning({ id: connectors.id });
    if (!updated) {
      return false;
    }
    for (const output of prepared) {
      const identity = {
        connectorId: args.connection.connectorId,
        storage,
        name: output.name,
        orgId: args.orgId,
        userId: args.userId,
      };
      if (output.kind === "secret") {
        await upsertConnectorOwnedSecret(tx, {
          ...identity,
          description: `Connector token output for ${args.connection.connectorSlug}: ${output.name}`,
          encryptedValue: output.encryptedValue,
        });
      } else {
        await upsertConnectorOwnedVariable(tx, {
          ...identity,
          description: null,
          value: output.value,
        });
      }
    }
    return true;
  });
  signal.throwIfAborted();
  return persisted
    ? { kind: "ok", tokenExpiresAt }
    : { kind: "connection-changed" };
}

async function markConnectorCredentialNeedsReconnectAfterRefreshFailure(
  args: {
    readonly connection: BuiltinConnectorCredentialConnection;
    readonly db: Db;
    readonly orgId: string;
    readonly reconnectReason: ConnectorReconnectReason | null;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const [row] = await args.db
    .update(connectors)
    .set({
      needsReconnect: true,
      reconnectReason: args.reconnectReason,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(connectorOwnershipCondition(args))
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return row !== undefined;
}

function terminalOAuthRefreshFailure(
  error: unknown,
): TerminalOAuthRefreshFailure | null {
  if (
    !isOAuthProviderHttpError(error) ||
    error.oauthError !== "invalid_grant"
  ) {
    return null;
  }
  if (error.oauthErrorSubtype === "invalid_rapt") {
    return { reconnectReason: "provider_session_expired" };
  }
  return {
    reconnectReason: error.oauthErrorSubtype
      ? null
      : "authorization_expired_or_revoked",
  };
}

async function terminalConnectorCredentialRefreshFailure(
  args: BuiltinConnectorCredentialRefreshArgs,
  error: unknown,
  signal: AbortSignal,
): Promise<BuiltinConnectorCredentialRefreshResult | null> {
  const terminalFailure = terminalOAuthRefreshFailure(error);
  if (terminalFailure === null) {
    return null;
  }
  if (!args.persist) {
    return { kind: "reconnect-required" };
  }
  const updated =
    await markConnectorCredentialNeedsReconnectAfterRefreshFailure(
      {
        connection: args.connection,
        db: args.persist.db,
        orgId: args.orgId,
        reconnectReason: terminalFailure.reconnectReason,
        userId: args.userId,
      },
      signal,
    );
  return { kind: updated ? "reconnect-required" : "connection-changed" };
}

async function connectorCredentialRefreshFailure(
  args: BuiltinConnectorCredentialRefreshArgs,
  kind: "invalid-output" | "missing-input" | "provider-failed",
  signal: AbortSignal,
): Promise<BuiltinConnectorCredentialRefreshResult> {
  if (
    kind !== "invalid-output" &&
    args.persist?.markNeedsReconnectOnFailure === true
  ) {
    await markConnectorCredentialNeedsReconnectAfterRefreshFailure(
      {
        connection: args.connection,
        db: args.persist.db,
        orgId: args.orgId,
        reconnectReason: null,
        userId: args.userId,
      },
      signal,
    );
  }
  return { kind };
}

async function loadConnectorRefreshInputs(
  args: BuiltinConnectorCredentialRefreshArgs,
  access: BuiltinConnectorRefreshTokenAccess,
): Promise<Readonly<Record<string, string>> | null> {
  const inputValues = await loadBuiltinConnectorCredentialValues({
    connection: args.connection,
    db: args.db,
    valueRefs: Object.values(access.inputs),
    ...(args.featureSwitchContext === undefined
      ? {}
      : { featureSwitchContext: args.featureSwitchContext }),
  });
  const inputs: Record<string, string> = {};
  for (const [inputName, valueRef] of Object.entries(access.inputs)) {
    const value = inputValues.get(valueRef);
    if (value === undefined) {
      return null;
    }
    inputs[inputName] = value;
  }
  return inputs;
}

function connectorRefreshAccessToken(args: {
  readonly access: BuiltinConnectorRefreshTokenAccess;
  readonly connection: BuiltinConnectorCredentialConnection;
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly runtimeEnvironmentName: string;
}): string | null {
  const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
    args.connection,
    args.runtimeEnvironmentName,
  );
  if (accessTokenValueRef === null) {
    return null;
  }
  const accessTokenOutputName = Object.entries(args.access.outputs).find(
    ([, valueRef]) => {
      return valueRef === accessTokenValueRef;
    },
  )?.[0];
  return accessTokenOutputName === undefined
    ? null
    : (args.outputs[accessTokenOutputName] ?? null);
}

export async function refreshBuiltinConnectorCredentialAccess(
  args: BuiltinConnectorCredentialRefreshArgs,
  signal: AbortSignal,
): Promise<BuiltinConnectorCredentialRefreshResult> {
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
  const inputs = await loadConnectorRefreshInputs(args, access);
  if (inputs === null) {
    return await connectorCredentialRefreshFailure(
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
        inputs,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!refreshed.ok) {
    const terminalFailure = await terminalConnectorCredentialRefreshFailure(
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
    if (isTransientOAuthRefreshFailure(refreshed.error)) {
      return { kind: "provider-failed" };
    }
    return await connectorCredentialRefreshFailure(
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
    return await connectorCredentialRefreshFailure(
      args,
      "invalid-output",
      signal,
    );
  }
  const persisted = args.persist
    ? await persistConnectorRefresh(
        {
          connection: args.connection,
          db: args.persist.db,
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
    return persisted;
  }
  return {
    kind: "ok",
    accessToken,
    tokenExpiresAt: persisted.tokenExpiresAt,
  };
}
