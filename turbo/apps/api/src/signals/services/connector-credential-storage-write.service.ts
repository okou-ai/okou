import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNotNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { ConnectorRuntimeMethod } from "./connector-catalog-runtime.service";

export interface ConnectorCredentialStorageDeclaration {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

export interface PreparedBuiltinConnectorTokenState {
  readonly secrets: readonly {
    readonly name: string;
    readonly encryptedValue: string;
    readonly description: string;
  }[];
  readonly variables: readonly {
    readonly name: string;
    readonly value: string;
  }[];
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

interface ManualGrantUserCredentialDeletion {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface ConnectorCredentialWriteScope {
  readonly connectorId: string;
  readonly method: Pick<ConnectorRuntimeMethod["method"], "storage">;
  readonly orgId: string;
  readonly userId: string;
}

interface ManualGrantCredentialInputs {
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly encryptedSecrets: readonly {
    readonly name: string;
    readonly encryptedValue: string;
  }[];
  readonly prepared: {
    readonly variableValues: readonly {
      readonly name: string;
      readonly value: string;
    }[];
  };
}

export function manualGrantCredentialArgs(
  args: ManualGrantCredentialInputs,
  connectorId: string,
) {
  return {
    connectorId,
    encryptedSecrets: args.encryptedSecrets,
    method: args.runtimeMethod.method,
    orgId: args.orgId,
    userId: args.userId,
    variableValues: args.prepared.variableValues,
  };
}

export function manualGrantConnectionMetadata(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
}) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    authMethod: args.runtimeMethod.authMethodId,
    storageVersion: args.runtimeMethod.method.storage.version,
    tokenExpiresAt: null,
    target: {
      kind: "builtin" as const,
      connectorSlug: args.runtimeMethod.connectorSlug,
      identity: { kind: "local" as const },
    },
  };
}

type ManualGrantCredentialEntry =
  | {
      readonly kind: "secret";
      readonly field: ManualGrantCredentialInputs["encryptedSecrets"][number];
    }
  | {
      readonly kind: "variable";
      readonly field: ManualGrantCredentialInputs["prepared"]["variableValues"][number];
    };

export function* manualGrantCredentialFields(
  args: ReturnType<typeof manualGrantCredentialArgs>,
): Generator<ManualGrantCredentialEntry, void> {
  for (const field of args.encryptedSecrets) {
    yield { kind: "secret" as const, field };
  }
  for (const field of args.variableValues) {
    yield { kind: "variable" as const, field };
  }
}

export function manualGrantCredentialWrite(
  args: ConnectorCredentialWriteScope,
  entry: ManualGrantCredentialEntry,
) {
  return entry.kind === "secret"
    ? { table: secrets, ...manualGrantSecretWrite(args, entry.field) }
    : { table: variables, ...manualGrantVariableWrite(args, entry.field) };
}

export function* builtinTokenCredentialWrites(
  connectorId: string,
  args: Omit<ConnectorCredentialWriteScope, "connectorId"> & {
    readonly state: PreparedBuiltinConnectorTokenState;
  },
) {
  const scope = {
    connectorId,
    storage: args.method.storage,
    orgId: args.orgId,
    userId: args.userId,
  };
  for (const secret of args.state.secrets) {
    yield {
      kind: "secret" as const,
      table: secrets,
      ...connectorOwnedSecretWrite({
        ...scope,
        ...secret,
        updatedDescription: secret.description,
      }),
    };
  }
  for (const variable of args.state.variables) {
    yield {
      kind: "variable" as const,
      table: variables,
      ...connectorOwnedVariableWrite({
        ...scope,
        ...variable,
        description: null,
        updatedDescription: null,
      }),
    };
  }
}

function manualGrantSecretWrite(
  args: ConnectorCredentialWriteScope,
  field: { readonly name: string; readonly encryptedValue: string },
) {
  return connectorOwnedSecretWrite({
    connectorId: args.connectorId,
    storage: args.method.storage,
    orgId: args.orgId,
    userId: args.userId,
    name: field.name,
    encryptedValue: field.encryptedValue,
    description: null,
    updatedDescription: null,
  });
}

function manualGrantVariableWrite(
  args: ConnectorCredentialWriteScope,
  field: { readonly name: string; readonly value: string },
) {
  return connectorOwnedVariableWrite({
    connectorId: args.connectorId,
    storage: args.method.storage,
    orgId: args.orgId,
    userId: args.userId,
    name: field.name,
    value: field.value,
    description: null,
    updatedDescription: null,
  });
}

export function manualGrantUserSecretDeletion(
  args: ManualGrantUserCredentialDeletion,
) {
  return {
    from: secrets,
    where: and(
      eq(secrets.orgId, args.orgId),
      eq(secrets.userId, args.userId),
      eq(secrets.name, args.name),
      eq(secrets.type, "user"),
    ),
  };
}

export function manualGrantUserVariableDeletion(
  scope: Omit<ManualGrantUserCredentialDeletion, "name">,
  name: string,
) {
  const args = { ...scope, name };
  return {
    from: variables,
    where: and(
      eq(variables.orgId, args.orgId),
      eq(variables.userId, args.userId),
      eq(variables.type, "user"),
      eq(variables.name, args.name),
    ),
  };
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
