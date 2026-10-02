import type {
  OrgCustomConnectorAuthMode,
  OrgCustomConnectorMcpTransport,
} from "@okouai/db/schema/org-custom-connector";

export type ConnectorSourceIdentity =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: string;
      readonly sourceId: string;
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly sourceId: string;
    };
export interface ConnectorSourcesRequest {
  readonly orgId: string;
  readonly userId: string;
  readonly sources: readonly ConnectorSourceIdentity[];
}
export interface EncryptedConnectorCredential {
  readonly id: string;
  readonly name: string;
  readonly encryptedValue: string;
}
/** Saved connection facts needed to judge credential validity at execution. */
export interface ConnectorSourceConnection {
  readonly authMethod: string;
  readonly storageVersion: number;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly updatedAt: Date;
}
/** Custom definition and OAuth binding captured by the bootstrap loader. */
export interface CustomConnectorSourceBinding {
  readonly definitionAuthMode: OrgCustomConnectorAuthMode;
  readonly definitionStorageVersion: number;
  readonly definitionMcpTransport: OrgCustomConnectorMcpTransport | null;
  readonly automaticOAuthBindingId: string | null;
}
export interface ConnectorSourceSnapshot {
  readonly source: ConnectorSourceIdentity;
  readonly connection: ConnectorSourceConnection;
  readonly customBinding: CustomConnectorSourceBinding | null;
  readonly variables: Readonly<Record<string, string>>;
  readonly credentials: readonly EncryptedConnectorCredential[];
}
export type ConnectorSourceResult =
  | { readonly kind: "available"; readonly snapshot: ConnectorSourceSnapshot }
  | { readonly kind: "unavailable"; readonly source: ConnectorSourceIdentity };

export interface ConnectorSourceRow extends ConnectorSourceConnection {
  readonly id: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
  readonly customOrgId: string | null;
  readonly customEnabled: boolean | null;
  readonly definitionAuthMode: OrgCustomConnectorAuthMode | null;
  readonly definitionStorageVersion: number | null;
  readonly definitionMcpTransport: OrgCustomConnectorMcpTransport | null;
  readonly automaticOAuthBindingId: string | null;
}

export interface ConnectorSourceValues {
  readonly variables: readonly {
    readonly sourceId: string | null;
    readonly name: string;
    readonly value: string;
  }[];
  readonly credentials: readonly (EncryptedConnectorCredential & {
    readonly sourceId: string | null;
  })[];
}

function sourceMatches(
  request: ConnectorSourcesRequest,
  source: ConnectorSourceIdentity,
  row: ConnectorSourceRow | undefined,
): row is ConnectorSourceRow {
  return (
    row !== undefined &&
    (source.kind === "builtin"
      ? row.connectorSlug === source.connectorSlug &&
        row.customConnectorId === null
      : row.customConnectorId === source.customConnectorId &&
        row.customOrgId === request.orgId &&
        row.customEnabled === true)
  );
}

function sourceSnapshot(
  source: ConnectorSourceIdentity,
  row: ConnectorSourceRow,
  values: ConnectorSourceValues,
): ConnectorSourceSnapshot {
  return {
    source,
    connection: {
      authMethod: row.authMethod,
      storageVersion: row.storageVersion,
      needsReconnect: row.needsReconnect,
      tokenExpiresAt: row.tokenExpiresAt,
      updatedAt: row.updatedAt,
    },
    customBinding:
      source.kind === "custom" &&
      row.definitionAuthMode !== null &&
      row.definitionStorageVersion !== null
        ? {
            definitionAuthMode: row.definitionAuthMode,
            definitionStorageVersion: row.definitionStorageVersion,
            definitionMcpTransport: row.definitionMcpTransport,
            automaticOAuthBindingId: row.automaticOAuthBindingId,
          }
        : null,
    variables: Object.fromEntries(
      values.variables
        .filter((value) => {
          return value.sourceId === source.sourceId;
        })
        .map((value) => {
          return [value.name, value.value];
        }),
    ),
    credentials: values.credentials
      .filter((value) => {
        return value.sourceId === source.sourceId;
      })
      .map(({ id, name, encryptedValue }) => {
        return { id, name, encryptedValue };
      }),
  };
}

/** Resolve exact saved sources from one identity-scoped snapshot, without I/O. */
export function connectorSourceSnapshotsFromRows(
  request: ConnectorSourcesRequest,
  rows: readonly ConnectorSourceRow[],
  values: ConnectorSourceValues,
): readonly ConnectorSourceResult[] {
  const available = new Map(
    rows
      .filter((row) => {
        // Custom OAuth sources remain refreshable at runtime; the caller owns
        // admission of their reconnect state, as well as account selection.
        return (
          row.customConnectorId !== null ||
          !row.needsReconnect ||
          row.authMethod === "none"
        );
      })
      .map((row) => {
        return [row.id, row];
      }),
  );
  return request.sources.map((source): ConnectorSourceResult => {
    const row = available.get(source.sourceId);
    return sourceMatches(request, source, row)
      ? { kind: "available", snapshot: sourceSnapshot(source, row, values) }
      : { kind: "unavailable", source };
  });
}
