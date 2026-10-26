import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";

import {
  connectorOwnedSecretWrite,
  connectorOwnedVariableWrite,
  type ConnectorCredentialStorageDeclaration,
} from "./connector-credential-storage-write.service";

export type PreparedCustomConnectorValue =
  | {
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string;
    }
  | {
      readonly kind: "variable";
      readonly key: string;
      readonly value: string;
    };

interface CustomConnectorCredentialField {
  readonly kind: "secret" | "variable";
  readonly key: string;
}

export type CustomConnectorMemberConnectionDeletionResult =
  | { readonly kind: "missing" }
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

export function customConnectorStorageDeclaration(
  fields: readonly CustomConnectorCredentialField[],
): ConnectorCredentialStorageDeclaration {
  return {
    secrets: fields.flatMap((field) => {
      return field.kind === "secret" ? [field.key] : [];
    }),
    variables: fields.flatMap((field) => {
      return field.kind === "variable" ? [field.key] : [];
    }),
  };
}

export function customConnectorCredentialValues(
  owner: { readonly orgId: string; readonly userId: string },
  fields: readonly CustomConnectorCredentialField[],
  values: readonly PreparedCustomConnectorValue[],
) {
  return { orgId: owner.orgId, userId: owner.userId, fields, values };
}

export function* customConnectorCredentialWrites(
  values: ReturnType<typeof customConnectorCredentialValues>,
  connectionId: string,
) {
  const preparedWrite = { connectionId, ...values };
  const storage = customConnectorStorageDeclaration(preparedWrite.fields);
  for (const value of preparedWrite.values) {
    yield {
      field: value,
      ...customConnectorValueCredentialWrite(preparedWrite, storage, value),
    };
  }
}

function customConnectorValueCredentialScope(
  preparedWrite: {
    readonly connectionId: string;
    readonly orgId: string;
    readonly userId: string;
  },
  storage: ReturnType<typeof customConnectorStorageDeclaration>,
) {
  return {
    connectorId: preparedWrite.connectionId,
    storage,
    orgId: preparedWrite.orgId,
    userId: preparedWrite.userId,
  };
}

function customConnectorValueCredentialWrite(
  preparedWrite: Parameters<typeof customConnectorValueCredentialScope>[0],
  storage: ReturnType<typeof customConnectorStorageDeclaration>,
  value: PreparedCustomConnectorValue,
) {
  const credential = {
    ...customConnectorValueCredentialScope(preparedWrite, storage),
    name: value.key,
    description: null,
    updatedDescription: null,
  };
  return value.kind === "secret"
    ? {
        table: secrets,
        ...connectorOwnedSecretWrite({
          ...credential,
          encryptedValue: value.encryptedValue,
        }),
      }
    : {
        table: variables,
        ...connectorOwnedVariableWrite({ ...credential, value: value.value }),
      };
}
