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
import { lockConnectorState } from "./auth-state-lock.service";
import type {
  ConnectorRuntimeMethod,
  ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  connectorCredentialSecretReadCondition,
  connectorCredentialVariableReadCondition,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
} from "./connector-credential-access.service";
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

export interface ConnectorCredentialConnection {
  readonly access: ConnectorCredentialAccess;
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

type ConnectorCredentialConnectionResult =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ok";
      readonly connection: ConnectorCredentialConnection;
    };

interface ConnectorStoredValueRef {
  readonly kind: "secret" | "variable";
  readonly name: string;
  readonly valueRef: string;
}

type ConnectorCredentialRefreshResult =
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

interface ConnectorCredentialRefreshArgs {
  readonly connection: ConnectorCredentialConnection;
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

type ConnectorRefreshTokenAccess = Extract<
  ConnectorRuntimeMethod["method"]["access"],
  { readonly kind: "refresh-token" }
>;

interface TerminalOAuthRefreshFailure {
  readonly reconnectReason: ConnectorReconnectReason | null;
}

function parseOauthScopes(value: string | null): readonly string[] | null {
  return value === null ? null : oauthScopesSchema.parse(JSON.parse(value));
}

function connectorStoredValueRef(valueRef: string): ConnectorStoredValueRef {
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

export async function loadConnectorCredentialConnection(args: {
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly userId: string;
}): Promise<ConnectorCredentialConnectionResult> {
  const [row] = await args.db
    .select({
      authMethod: connectors.authMethod,
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
  const accessResult = resolveConnectorCredentialAccess({
    snapshot: args.snapshot,
    stored: {
      authMethodId: row.authMethod,
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

export function connectorCredentialRuntimeValueRef(
  connection: ConnectorCredentialConnection,
  environmentName: string,
): string | null {
  const access = connection.runtimeMethod.method.access;
  if (access.kind === "none") {
    return null;
  }
  const binding = access.envBindings[environmentName];
  if (binding === undefined) {
    return null;
  }
  return typeof binding === "string" ? binding : binding.valueRef;
}

export async function loadConnectorCredentialValues(args: {
  readonly connection: ConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly valueRefs: readonly string[];
}): Promise<ReadonlyMap<string, string>> {
  const refs = args.valueRefs.map(connectorStoredValueRef);
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
      connectorCredentialSecretReadCondition({
        db: args.db,
        groups: [
          {
            access: args.connection.access,
            names: secretNames,
          },
        ],
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
      connectorCredentialVariableReadCondition({
        db: args.db,
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

async function persistConnectorRefreshOutputs(
  args: {
    readonly access: ConnectorRefreshTokenAccess;
    readonly connection: ConnectorCredentialConnection;
    readonly db: Db;
    readonly orgId: string;
    readonly outputs: Readonly<Record<string, string | undefined>>;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  for (const [outputName, value] of Object.entries(args.outputs)) {
    if (value === undefined) {
      continue;
    }
    const valueRef = args.access.outputs[outputName];
    if (valueRef === undefined) {
      throw new Error("Connector refresh returned an undeclared output");
    }
    const target = connectorStoredValueRef(valueRef);
    if (target.kind === "secret") {
      const encryptedValue = await encryptStoredSecretValue(value);
      await upsertConnectorOwnedSecret(args.db, {
        connectorId: args.connection.connectorId,
        storage: args.connection.runtimeMethod.method.storage,
        description: `Connector token output for ${args.connection.connectorSlug}: ${target.name}`,
        encryptedValue,
        name: target.name,
        orgId: args.orgId,
        userId: args.userId,
      });
    } else {
      await upsertConnectorOwnedVariable(args.db, {
        connectorId: args.connection.connectorId,
        storage: args.connection.runtimeMethod.method.storage,
        description: null,
        name: target.name,
        orgId: args.orgId,
        userId: args.userId,
        value,
      });
    }
    signal.throwIfAborted();
  }
}

async function persistConnectorRefresh(
  args: {
    readonly connection: ConnectorCredentialConnection;
    readonly db: Db;
    readonly defaultExpiresInMs?: number;
    readonly featureSwitchContext?: FeatureSwitchContext;
    readonly inputs: Readonly<Record<string, string>>;
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
  const result = await args.db.transaction(async (tx) => {
    await lockConnectorState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: args.connection.connectorSlug,
    });
    signal.throwIfAborted();
    const [currentConnector] = await tx
      .select({
        authMethod: connectors.authMethod,
        externalEmail: connectors.externalEmail,
        externalId: connectors.externalId,
        needsReconnect: connectors.needsReconnect,
        reconnectReason: connectors.reconnectReason,
        stateRevision: sql`${connectors.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
        storageVersion: connectors.storageVersion,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.connection.connectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.connectorSlug, args.connection.connectorSlug),
        ),
      )
      .limit(1);
    const currentRevisionCanAcceptRefresh =
      currentConnector?.stateRevision === args.connection.stateRevision ||
      (currentConnector !== undefined &&
        !args.connection.needsReconnect &&
        currentConnector.needsReconnect &&
        currentConnector.reconnectReason === null);
    if (
      currentConnector?.authMethod !==
        args.connection.runtimeMethod.authMethodId ||
      currentConnector.externalEmail !== args.connection.externalEmail ||
      currentConnector.externalId !== args.connection.externalId ||
      currentConnector.storageVersion !==
        args.connection.runtimeMethod.method.storage.version ||
      !currentRevisionCanAcceptRefresh
    ) {
      return { kind: "connection-changed" } as const;
    }
    const currentInputValues = await loadConnectorCredentialValues({
      connection: args.connection,
      db: tx,
      valueRefs: Object.values(access.inputs),
      ...(args.featureSwitchContext === undefined
        ? {}
        : { featureSwitchContext: args.featureSwitchContext }),
    });
    for (const [inputName, valueRef] of Object.entries(access.inputs)) {
      if (currentInputValues.get(valueRef) !== args.inputs[inputName]) {
        return { kind: "connection-changed" } as const;
      }
    }
    await persistConnectorRefreshOutputs(
      {
        access,
        connection: args.connection,
        db: tx,
        orgId: args.orgId,
        outputs: args.outputs,
        userId: args.userId,
      },
      signal,
    );
    await tx
      .update(connectors)
      .set({
        ...(args.scopes === undefined
          ? {}
          : { oauthGrantedScopes: JSON.stringify(args.scopes) }),
        tokenExpiresAt,
        storageVersion: args.connection.runtimeMethod.method.storage.version,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, args.connection.connectorId));
    return { kind: "ok", tokenExpiresAt } as const;
  });
  signal.throwIfAborted();
  return result;
}

async function markConnectorCredentialNeedsReconnectAfterRefreshFailure(
  args: {
    readonly connection: ConnectorCredentialConnection;
    readonly db: Db;
    readonly orgId: string;
    readonly reconnectReason: ConnectorReconnectReason | null;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const updated = await args.db.transaction(async (tx) => {
    await lockConnectorState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: args.connection.connectorSlug,
    });
    signal.throwIfAborted();
    const [row] = await tx
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
    return row !== undefined;
  });
  signal.throwIfAborted();
  return updated;
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
  args: ConnectorCredentialRefreshArgs,
  error: unknown,
  signal: AbortSignal,
): Promise<ConnectorCredentialRefreshResult | null> {
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
  args: ConnectorCredentialRefreshArgs,
  kind: "invalid-output" | "missing-input" | "provider-failed",
  signal: AbortSignal,
): Promise<ConnectorCredentialRefreshResult> {
  if (args.persist?.markNeedsReconnectOnFailure === true) {
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
  args: ConnectorCredentialRefreshArgs,
  access: ConnectorRefreshTokenAccess,
): Promise<
  | { readonly kind: "ok"; readonly inputs: Readonly<Record<string, string>> }
  | { readonly kind: "missing-input" }
> {
  const inputValues = await loadConnectorCredentialValues({
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
      return { kind: "missing-input" };
    }
    inputs[inputName] = value;
  }
  return { kind: "ok", inputs };
}

function connectorRefreshAccessToken(args: {
  readonly access: ConnectorRefreshTokenAccess;
  readonly connection: ConnectorCredentialConnection;
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly runtimeEnvironmentName: string;
}): string | null {
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
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

export async function refreshConnectorCredentialAccess(
  args: ConnectorCredentialRefreshArgs,
  signal: AbortSignal,
): Promise<ConnectorCredentialRefreshResult> {
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
  const loadedInputs = await loadConnectorRefreshInputs(args, access);
  if (loadedInputs.kind === "missing-input") {
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
        inputs: loadedInputs.inputs,
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
          inputs: loadedInputs.inputs,
          orgId: args.orgId,
          outputs: refreshed.value.outputs,
          userId: args.userId,
          expiresIn: refreshed.value.expiresIn,
          ...(refreshed.value.scopes === undefined
            ? {}
            : { scopes: refreshed.value.scopes }),
          ...(args.featureSwitchContext === undefined
            ? {}
            : { featureSwitchContext: args.featureSwitchContext }),
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
