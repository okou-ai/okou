import type {
  ConnectorAccountConnection,
  connectorAccountFieldMetadataSchema,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorFieldSchema } from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  OrgCustomConnectorAuthMode,
  OrgCustomConnectorMcpTransport,
} from "@okouai/db/schema/org-custom-connector";
import type { ConnectorRuntimeAuthLookup } from "./connector-catalog-runtime.service";
import {
  builtinConnectorCredentialStorageIsCompatible,
  resolveStoredBuiltinConnectorRuntimeMethod,
} from "./builtin-connector-credential-access.service";
import {
  customConnectorAccountAuthMethodIsCompatible,
  customConnectorDefinitionFieldCompatibility,
  customConnectorAccountStorageIsCompatible,
} from "./custom-connector-credential-access.service";
import type { z } from "zod";

interface AccountSetupContract {
  readonly id: string;
  readonly authMethod: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly storageVersion: number;
  readonly definitionStorageVersion: number | null;
}

interface ConnectorAccountFieldMarker extends AccountSetupContract {
  readonly name: string;
  readonly kind: "secret" | "variable";
}

interface AccountSetupInput extends AccountSetupContract {
  readonly connectorSlug: string | null;
  readonly definitionAuthMode: OrgCustomConnectorAuthMode | null;
  readonly definitionMcpTransport: OrgCustomConnectorMcpTransport | null;
  readonly definitionFields: unknown;
}

type ConnectorAccountSetup = z.infer<
  typeof connectorAccountFieldMetadataSchema
> & {
  readonly reconnectReason:
    "configuration_incomplete" | "configuration_invalid" | null;
};

/** Configuration attention is derived; it never changes stored credential state. */
export function connectorAccountStatus(
  credential: Pick<
    ConnectorAccountConnection,
    "connectionStatus" | "reconnectReason"
  >,
  setup: ConnectorAccountSetup,
): Pick<
  ConnectorAccountConnection,
  | "connectionStatus"
  | "reconnectReason"
  | "missingRequiredFields"
  | "configuredFieldKeys"
> {
  return {
    ...setup,
    connectionStatus:
      credential.connectionStatus === "connected" &&
      setup.reconnectReason === null
        ? "connected"
        : "reconnect-required",
    reconnectReason:
      setup.reconnectReason === "configuration_invalid"
        ? setup.reconnectReason
        : (credential.reconnectReason ?? setup.reconnectReason),
  };
}

export function connectorAccountSetupMarkerKey(
  account: AccountSetupContract,
): string {
  return JSON.stringify([
    account.id,
    account.authMethod,
    account.automaticAuthType,
    account.storageVersion,
    account.definitionStorageVersion,
  ]);
}

export function connectorAccountSetup(
  account: AccountSetupInput,
  snapshot: ConnectorRuntimeAuthLookup | null,
  present: ReadonlySet<string>,
): ConnectorAccountSetup {
  let fields: readonly {
    readonly key: string;
    readonly privateName: string;
    readonly kind: "secret" | "variable";
    readonly required: boolean;
  }[];
  let valid: boolean;
  if (account.connectorSlug !== null) {
    const slug = connectorSlugSchema.safeParse(account.connectorSlug);
    const runtimeMethod =
      slug.success && snapshot
        ? resolveStoredBuiltinConnectorRuntimeMethod({
            snapshot,
            stored: {
              authMethodId: account.authMethod,
              connectorId: account.id,
              connectorSlug: slug.data,
            },
          })
        : undefined;
    valid =
      runtimeMethod !== undefined &&
      builtinConnectorCredentialStorageIsCompatible({
        runtimeMethod,
        automaticAuthType: account.automaticAuthType,
        storageVersion: account.storageVersion,
      });
    fields =
      runtimeMethod?.method.grant.kind === "manual"
        ? Object.entries(runtimeMethod.method.grant.fields).map(
            ([privateName, field]) => {
              return {
                key: field.publicId,
                privateName,
                kind: field.storage ?? "secret",
                required: field.required,
              };
            },
          )
        : [];
  } else {
    const parsed = customConnectorFieldSchema
      .array()
      .safeParse(account.definitionFields);
    valid =
      parsed.success &&
      account.definitionAuthMode !== null &&
      account.definitionStorageVersion !== null &&
      customConnectorDefinitionFieldCompatibility({
        authMode: account.definitionAuthMode,
        kind: account.definitionMcpTransport === null ? "http" : "mcp",
        fields: parsed.data,
      }) === null &&
      customConnectorAccountAuthMethodIsCompatible(
        account.definitionAuthMode,
        account.authMethod,
      ) &&
      customConnectorAccountStorageIsCompatible({
        authMethod: account.authMethod,
        mcpTransport: account.definitionMcpTransport,
        storageVersion: account.storageVersion,
        definitionStorageVersion: account.definitionStorageVersion,
      });
    fields = parsed.success
      ? parsed.data.map((field) => {
          return { ...field, privateName: field.key };
        })
      : [];
    if (
      new Set(
        fields.map((field) => {
          return field.key;
        }),
      ).size !== fields.length
    ) {
      valid = false;
    }
  }
  const configuredFieldKeys = fields
    .filter((field) => {
      return valid && present.has(`${field.kind}:${field.privateName}`);
    })
    .map((field) => {
      return field.key;
    })
    .sort();
  const missingRequiredFields = fields
    .filter((field) => {
      return (
        field.required &&
        (!valid || !present.has(`${field.kind}:${field.privateName}`))
      );
    })
    .map((field) => {
      return field.key;
    })
    .sort();
  return {
    reconnectReason: !valid
      ? "configuration_invalid"
      : missingRequiredFields.length > 0
        ? "configuration_incomplete"
        : null,
    missingRequiredFields,
    configuredFieldKeys,
  };
}

export function connectorAccountFieldMarkerKeys(
  markers: readonly ConnectorAccountFieldMarker[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byAccount = new Map<string, Set<string>>();
  for (const marker of markers) {
    const key = connectorAccountSetupMarkerKey(marker);
    const keys = byAccount.get(key) ?? new Set<string>();
    keys.add(`${marker.kind}:${marker.name}`);
    byAccount.set(key, keys);
  }
  return byAccount;
}
