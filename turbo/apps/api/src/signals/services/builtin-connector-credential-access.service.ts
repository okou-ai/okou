import {
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodOwnedVariableNames,
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
import { alias } from "drizzle-orm/pg-core";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import {
  getConnectorRuntimeConnector,
  getConnectorRuntimeMethod,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSelection,
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
  readonly snapshot: ConnectorRuntimeSelection;
  readonly stored: {
    readonly authMethodId: string;
    readonly connectorId: string;
    readonly connectorSlug: string;
  };
}): ConnectorRuntimeMethod | undefined {
  const runtimeConnector = getConnectorRuntimeConnector(
    args.snapshot,
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
  readonly snapshot: ConnectorRuntimeSelection;
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
  db: ReadonlyDb,
  access: BuiltinConnectorCredentialAccess,
  connectorStateRevision: bigint | undefined,
): SQL {
  return exists(
    db
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
  readonly db: ReadonlyDb;
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
          args.db,
          group.access,
          group.connectorStateRevision,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(secrets.id) : or(...conditions);
}

export function builtinConnectorCredentialVariableReadCondition(args: {
  readonly db: ReadonlyDb;
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
          args.db,
          group.access,
          group.connectorStateRevision,
        ),
      ),
    ];
  });
  return conditions.length === 0 ? isNull(variables.id) : or(...conditions);
}
