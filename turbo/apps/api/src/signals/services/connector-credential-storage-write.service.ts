import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { isNotNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";

export interface ConnectorCredentialStorageDeclaration {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

interface ConnectorOwnedCredentialWrite {
  readonly connectorId: string;
  readonly storage: ConnectorCredentialStorageDeclaration;
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
}

interface ConnectorOwnedCredentialDescription {
  readonly description: string | null;
  readonly updatedDescription?: string | null;
}

function requireDeclaredStorageName(args: {
  readonly kind: "secret" | "variable";
  readonly storage: ConnectorCredentialStorageDeclaration;
  readonly name: string;
}): void {
  const names =
    args.kind === "secret" ? args.storage.secrets : args.storage.variables;
  if (!names.includes(args.name)) {
    throw new Error(
      `Connector auth method does not declare ${args.kind} ${args.name}`,
    );
  }
}

export function connectorOwnedSecretWrite(
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly encryptedValue: string;
    },
) {
  requireDeclaredStorageName({
    kind: "secret",
    storage: args.storage,
    name: args.name,
  });
  return {
    values: {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      description: args.description,
      type: "connector",
    },
    conflict: {
      target: [secrets.connectorId, secrets.name],
      targetWhere: isNotNull(secrets.connectorId),
      set: {
        encryptedValue: args.encryptedValue,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    },
  };
}

export function connectorOwnedVariableWrite(
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly value: string;
    },
) {
  requireDeclaredStorageName({
    kind: "variable",
    storage: args.storage,
    name: args.name,
  });
  return {
    values: {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      value: args.value,
      description: args.description,
      type: "connector",
    },
    conflict: {
      target: [variables.connectorId, variables.name],
      targetWhere: isNotNull(variables.connectorId),
      set: {
        value: args.value,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    },
  };
}
