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
export interface ConnectorCredentialAccess {
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly orgId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly storageVersion: number;
  readonly userId: string;
}

type ConnectorCredentialAccessResult =
  | { readonly kind: "ok"; readonly access: ConnectorCredentialAccess }
  | { readonly kind: "unavailable" }
  | { readonly kind: "incompatible" };

interface ConnectorCredentialStoredIdentity {
  readonly authMethodId: string;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly userId: string;
}

export interface ConnectorCredentialReadGroup {
  readonly access: ConnectorCredentialAccess;
  /**
   * Multi-phase readers may pin the connector row they originally observed.
   * Single-statement and connector-locked callers do not need this condition.
   */
  readonly connectorStateRevision?: bigint;
  readonly names: readonly string[];
}

const credentialAccessConnector = alias(
  connectors,
  "credential_access_connector",
);

export function connectorCredentialStorageIsCompatible(args: {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly storageVersion: number;
}): boolean {
  return (
    args.runtimeMethod.method.grant.kind === "none" ||
    args.storageVersion === args.runtimeMethod.method.storage.version
  );
}

export function resolveStoredConnectorRuntimeMethod(args: {
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

export function resolveConnectorCredentialAccess(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly stored: ConnectorCredentialStoredIdentity;
}): ConnectorCredentialAccessResult {
  const runtimeMethod = resolveStoredConnectorRuntimeMethod({
    snapshot: args.snapshot,
    stored: args.stored,
  });
  if (!runtimeMethod) {
    return { kind: "unavailable" };
  }
  if (
    !connectorCredentialStorageIsCompatible({
      runtimeMethod,
      storageVersion: args.stored.storageVersion,
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
  readonly access: ConnectorCredentialAccess;
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
  access: ConnectorCredentialAccess,
  connectorStateRevision: bigint | undefined,
): SQL {
  return exists(
    db
      .select({ connectorId: credentialAccessConnector.id })
      .from(credentialAccessConnector)
      .where(
        and(
          eq(credentialAccessConnector.id, access.connectorId),
          eq(credentialAccessConnector.orgId, access.orgId),
          eq(credentialAccessConnector.userId, access.userId),
          eq(credentialAccessConnector.connectorSlug, access.connectorSlug),
          eq(credentialAccessConnector.authMethod, access.authMethodId),
          eq(credentialAccessConnector.storageVersion, access.storageVersion),
          connectorStateRevision === undefined
            ? undefined
            : eq(
                sql`(
                  EXTRACT(EPOCH FROM ${credentialAccessConnector.updatedAt})
                  * 1000000
                )::bigint`,
                connectorStateRevision,
              ),
        ),
      ),
  );
}

export function connectorCredentialSecretReadCondition(args: {
  readonly db: ReadonlyDb;
  readonly groups: readonly ConnectorCredentialReadGroup[];
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

export function connectorCredentialVariableReadCondition(args: {
  readonly db: ReadonlyDb;
  readonly groups: readonly ConnectorCredentialReadGroup[];
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
