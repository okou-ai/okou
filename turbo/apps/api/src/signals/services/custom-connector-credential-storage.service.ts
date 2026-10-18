import type { ConnectorCredentialStorageDeclaration } from "./connector-credential-storage-write.service";

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
