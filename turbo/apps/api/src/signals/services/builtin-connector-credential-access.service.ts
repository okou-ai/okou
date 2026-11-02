import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodOwnedVariableNames,
  connectorAuthMethodRevokeMetadata,
  type ConnectorRevokeInputMetadata,
} from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import { logger } from "../../lib/log";
import {
  getConnectorRuntimeMethod,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeAuthLookup,
} from "./connector-catalog-runtime.service";

const log = logger("api:connector-credential-access");

/**
 * One executable stored connection, resolved against one immutable catalog
 * snapshot. Feature-switch visibility is discovery policy and deliberately
 * does not participate in this access boundary: disabling discovery must not
 * invalidate an already compatible stored connection.
 */
export interface BuiltinConnectorCredentialAccess {
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly orgId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly storageVersion: number;
  readonly userId: string;
}

type BuiltinConnectorCredentialAccessResult =
  | { readonly kind: "ok"; readonly access: BuiltinConnectorCredentialAccess }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

interface BuiltinConnectorCredentialStoredIdentity {
  readonly automaticAuthType?: "none" | "oauth" | null;
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly userId: string;
}

export interface BuiltinConnectorCredentialReadGroup {
  readonly access: BuiltinConnectorCredentialAccess;
  /**
   * Multi-phase readers may pin the connector row they originally observed.
   * Single-statement and connector-locked callers do not need this condition.
   */
  readonly connectorStateRevision?: bigint;
  readonly connectorUpdatedAt?: string;
  readonly names: readonly string[];
}

const builtinCredentialAccessConnector = alias(
  connectors,
  "credential_access_connector",
);

export function builtinConnectorCredentialStorageIsCompatible(args: {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly automaticAuthType?: "none" | "oauth" | null;
  readonly storageVersion: number;
}): boolean {
  return (
    args.runtimeMethod.method.grant.kind === "none" ||
    (args.runtimeMethod.method.grant.kind === "automatic" &&
      args.automaticAuthType === "none") ||
    args.storageVersion === args.runtimeMethod.method.storage.version
  );
}

export function resolveStoredBuiltinConnectorRuntimeMethod(args: {
  readonly snapshot: ConnectorRuntimeAuthLookup;
  readonly stored: {
    readonly authMethodId: string;
    readonly connectorId: string;
    readonly connectorSlug: string;
  };
}): ConnectorRuntimeMethod | undefined {
  const runtimeConnector = args.snapshot.connectors.get(
    args.stored.connectorSlug,
  );
  if (
    runtimeConnector === undefined ||
    !runtimeConnector.catalogConnector.authMethods.some((method) => {
      return method.id === args.stored.authMethodId;
    })
  ) {
    return undefined;
  }

  const runtimeMethod = getConnectorRuntimeMethod({
    snapshot: args.snapshot,
    connectorSlug: args.stored.connectorSlug,
    authMethodId: args.stored.authMethodId,
  });
  if (runtimeMethod?.executable !== true) {
    log.warn("Stored connector runtime method is unavailable", {
      connectorId: args.stored.connectorId,
      connectorSlug: args.stored.connectorSlug,
      authMethodId: args.stored.authMethodId,
      reason: "missing_executable_capability",
    });
    return undefined;
  }
  return runtimeMethod;
}

export function resolveBuiltinConnectorCredentialAccess(args: {
  readonly snapshot: ConnectorRuntimeAuthLookup;
  readonly stored: BuiltinConnectorCredentialStoredIdentity;
}): BuiltinConnectorCredentialAccessResult {
  const runtimeMethod = resolveStoredBuiltinConnectorRuntimeMethod({
    snapshot: args.snapshot,
    stored: args.stored,
  });
  if (!runtimeMethod) {
    return { kind: "unavailable" };
  }
  if (
    !builtinConnectorCredentialStorageIsCompatible({
      runtimeMethod,
      storageVersion: args.stored.storageVersion,
      automaticAuthType: args.stored.automaticAuthType,
    })
  ) {
    return { kind: "incompatible" };
  }
  return {
    kind: "ok",
    access: {
      authMethodId: args.stored.authMethodId,
      connectorId: args.stored.connectorId,
      connectorSlug: args.stored.connectorSlug,
      orgId: args.stored.orgId,
      runtimeMethod,
      storageVersion: runtimeMethod.method.storage.version,
      userId: args.stored.userId,
    },
  };
}

function assertDeclaredNames(args: {
  readonly access: BuiltinConnectorCredentialAccess;
  readonly kind: "secret" | "variable";
  readonly names: readonly string[];
}): void {
  const declaredNames = new Set(
    args.kind === "secret"
      ? connectorAuthMethodOwnedSecretNames(args.access.runtimeMethod.method)
      : connectorAuthMethodOwnedVariableNames(args.access.runtimeMethod.method),
  );
  for (const name of args.names) {
    if (!declaredNames.has(name)) {
      throw new Error(
        `Connector ${args.kind} is not declared by the selected auth method`,
      );
    }
  }
}

function connectorIdentityExists(
  access: BuiltinConnectorCredentialAccess,
  connectorStateRevision: bigint | undefined,
  connectorUpdatedAt: string | undefined,
): SQL {
  return exists(
    new QueryBuilder()
      .select({ connectorId: builtinCredentialAccessConnector.id })
      .from(builtinCredentialAccessConnector)
      .where(
        and(
          eq(builtinCredentialAccessConnector.id, access.connectorId),
          eq(builtinCredentialAccessConnector.orgId, access.orgId),
          eq(builtinCredentialAccessConnector.userId, access.userId),
          eq(
            builtinCredentialAccessConnector.connectorSlug,
            access.connectorSlug,
          ),
          eq(builtinCredentialAccessConnector.authMethod, access.authMethodId),
          eq(
            builtinCredentialAccessConnector.storageVersion,
            access.storageVersion,
          ),
          connectorUpdatedAt === undefined
            ? undefined
            : eq(
                sql`${builtinCredentialAccessConnector.updatedAt}::text`,
                connectorUpdatedAt,
              ),
          connectorStateRevision === undefined
            ? undefined
            : eq(
                sql`(
                  EXTRACT(EPOCH FROM ${builtinCredentialAccessConnector.updatedAt})
                  * 1000000
                )::bigint`,
                connectorStateRevision,
              ),
        ),
      ),
  );
}

export function builtinConnectorCredentialSecretReadCondition(args: {
  readonly groups: readonly BuiltinConnectorCredentialReadGroup[];
}): SQL | undefined {
  const conditions = args.groups.flatMap((group) => {
    const names = [...new Set(group.names)];
    if (names.length === 0) {
      return [];
    }
    assertDeclaredNames({
      access: group.access,
      kind: "secret",
      names,
    });
    return [
      and(
        eq(secrets.orgId, group.access.orgId),
        eq(secrets.userId, group.access.userId),
        eq(secrets.type, "connector"),
        inArray(secrets.name, names),
        eq(secrets.connectorId, group.access.connectorId),
        connectorIdentityExists(
          group.access,
          group.connectorStateRevision,
          group.connectorUpdatedAt,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(secrets.id) : or(...conditions);
}

export function builtinConnectorCredentialVariableReadCondition(args: {
  readonly groups: readonly BuiltinConnectorCredentialReadGroup[];
}): SQL | undefined {
  const conditions = args.groups.flatMap((group) => {
    const names = [...new Set(group.names)];
    if (names.length === 0) {
      return [];
    }
    assertDeclaredNames({
      access: group.access,
      kind: "variable",
      names,
    });
    return [
      and(
        eq(variables.orgId, group.access.orgId),
        eq(variables.userId, group.access.userId),
        eq(variables.type, "connector"),
        inArray(variables.name, names),
        eq(variables.connectorId, group.access.connectorId),
        connectorIdentityExists(
          group.access,
          group.connectorStateRevision,
          group.connectorUpdatedAt,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(variables.id) : or(...conditions);
}

export function builtinConnectorTokenRevokeReadPlan(
  access: BuiltinConnectorCredentialAccess,
) {
  const revokeMetadata = connectorAuthMethodRevokeMetadata(
    access.runtimeMethod.method,
  );
  if (revokeMetadata?.kind !== "token-revoke") {
    return { kind: "none" } as const;
  }

  const inputEntries = Object.entries(revokeMetadata.inputs);
  if (inputEntries.length === 0) {
    return { kind: "empty" } as const;
  }

  const secretNames = inputEntries.map(([, input]) => {
    return input.secretName;
  });
  return {
    kind: "read" as const,
    inputEntries,
    columns: { name: secrets.name, encryptedValue: secrets.encryptedValue },
    from: secrets,
    where: builtinConnectorCredentialSecretReadCondition({
      groups: [{ access, names: secretNames }],
    }),
  };
}

export function builtinConnectorTokenRevokeInputsFromRows(
  inputEntries: readonly (readonly [string, ConnectorRevokeInputMetadata])[],
  secretRows: readonly {
    readonly name: string;
    readonly encryptedValue: string | null;
  }[],
): Readonly<Record<string, string>> | null {
  const encryptedValuesByName = new Map(
    secretRows.flatMap((row) => {
      return row.encryptedValue ? [[row.name, row.encryptedValue]] : [];
    }),
  );
  const encryptedInputs: Record<string, string> = {};
  for (const [inputName, input] of inputEntries) {
    const encryptedValue = encryptedValuesByName.get(input.secretName);
    if (!encryptedValue) {
      return null;
    }
    encryptedInputs[inputName] = encryptedValue;
  }
  return encryptedInputs;
}

export interface BuiltinConnectorPendingTokenRevokeArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot: ConnectorRuntimeAuthLookup;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly existing: {
    readonly id: string;
    readonly authMethod: string;
    readonly storageVersion: number;
  } | null;
  readonly replacement: "local" | "token";
}

export function prepareBuiltinTokenRevoke(
  args: BuiltinConnectorPendingTokenRevokeArgs,
) {
  if (!args.existing) {
    return null;
  }
  const accessResult = resolveBuiltinConnectorCredentialAccess({
    snapshot: args.snapshot,
    stored: {
      authMethodId: args.existing.authMethod,
      connectorId: args.existing.id,
      connectorSlug: args.connectorSlug,
      orgId: args.orgId,
      storageVersion: args.existing.storageVersion,
      userId: args.userId,
    },
  });
  if (
    accessResult.kind !== "ok" ||
    accessResult.access.runtimeMethod.method.revoke.kind !== "token-revoke"
  ) {
    return null;
  }
  if (
    args.replacement === "token" &&
    accessResult.access.runtimeMethod.method.revoke.revokePreviousOnReplace !==
      true
  ) {
    return null;
  }
  const context = {
    access: accessResult.access,
    featureSwitchContext: args.featureSwitchContext,
  };
  return context;
}

export function prepareBuiltinConnectorAccountDeletionRevoke(
  args: Omit<
    BuiltinConnectorPendingTokenRevokeArgs,
    "snapshot" | "featureSwitchContext" | "replacement"
  > & {
    readonly snapshot: ConnectorRuntimeAuthLookup | null;
    readonly featureSwitchContext: FeatureSwitchContext | null;
  },
) {
  if (args.snapshot === null || args.featureSwitchContext === null) {
    return null;
  }
  return prepareBuiltinTokenRevoke({
    ...args,
    snapshot: args.snapshot,
    featureSwitchContext: args.featureSwitchContext,
    replacement: "local",
  });
}

export function builtinTokenRevokeFromRows(
  preparation: NonNullable<ReturnType<typeof prepareBuiltinTokenRevoke>>,
  read: ReturnType<typeof builtinConnectorTokenRevokeReadPlan>,
  secretRows: readonly {
    readonly name: string;
    readonly encryptedValue: string | null;
  }[],
) {
  if (read.kind === "none") {
    return null;
  }
  const encryptedInputs =
    read.kind === "empty"
      ? {}
      : builtinConnectorTokenRevokeInputsFromRows(
          read.inputEntries,
          secretRows,
        );
  if (encryptedInputs === null) {
    return null;
  }
  return {
    runtimeMethod: preparation.access.runtimeMethod,
    encryptedInputs,
    featureSwitchContext: preparation.featureSwitchContext,
  };
}
