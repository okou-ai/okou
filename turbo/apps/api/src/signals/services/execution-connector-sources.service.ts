import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
  type OrgCustomConnectorMcpTransport,
} from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { db$, type ReadonlyDb } from "../external/db";

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
/**
 * Custom definition revision and OAuth binding observed in the same statement
 * as the saved source, used as the execution version/binding fence.
 */
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

async function loadSourceRows(
  db: ReadonlyDb,
  request: ConnectorSourcesRequest,
  ids: readonly string[],
) {
  return await db
    .select({
      id: connectors.id,
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
      needsReconnect: connectors.needsReconnect,
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
      updatedAt: connectors.updatedAt,
      customOrgId: orgCustomConnectors.orgId,
      customEnabled: orgCustomConnectors.enabled,
      definitionAuthMode: orgCustomConnectors.authMode,
      definitionStorageVersion: orgCustomConnectors.storageVersion,
      definitionMcpTransport: orgCustomConnectors.mcpTransport,
      automaticOAuthBindingId:
        customConnectorAccountOauthBindings.connectorAccountId,
    })
    .from(connectors)
    .leftJoin(
      orgCustomConnectors,
      eq(orgCustomConnectors.id, connectors.customConnectorId),
    )
    .leftJoin(
      customConnectorAccountOauthBindings,
      and(
        eq(
          customConnectorAccountOauthBindings.connectorAccountId,
          connectors.id,
        ),
        eq(
          customConnectorAccountOauthBindings.customConnectorId,
          orgCustomConnectors.id,
        ),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, request.orgId),
        eq(connectors.userId, request.userId),
        inArray(connectors.id, [...ids]),
      ),
    );
}
type SourceRow = Awaited<ReturnType<typeof loadSourceRows>>[number];

async function loadSourceValues(
  db: ReadonlyDb,
  request: ConnectorSourcesRequest,
  sourceIds: readonly string[],
) {
  if (sourceIds.length === 0) {
    return { variables: [], credentials: [] };
  }
  const [storedVariables, storedCredentials] = await Promise.all([
    db
      .select({
        sourceId: variables.connectorId,
        name: variables.name,
        value: variables.value,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, request.orgId),
          eq(variables.userId, request.userId),
          eq(variables.type, "connector"),
          inArray(variables.connectorId, [...sourceIds]),
        ),
      ),
    db
      .select({
        sourceId: secrets.connectorId,
        id: secrets.id,
        name: secrets.name,
        encryptedValue: secrets.encryptedValue,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, request.orgId),
          eq(secrets.userId, request.userId),
          eq(secrets.type, "connector"),
          inArray(secrets.connectorId, [...sourceIds]),
        ),
      ),
  ]);
  return { variables: storedVariables, credentials: storedCredentials };
}
type SourceValues = Awaited<ReturnType<typeof loadSourceValues>>;

function sourceMatches(
  request: ConnectorSourcesRequest,
  source: ConnectorSourceIdentity,
  row: SourceRow | undefined,
): row is SourceRow {
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
  row: SourceRow,
  values: SourceValues,
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

/** Exact saved source values. Account selection and runtime policy remain caller-owned. */
export function createConnectorSourceSnapshots(
  request: ConnectorSourcesRequest,
): Computed<Promise<readonly ConnectorSourceResult[]>> {
  return computed(async (get) => {
    if (request.sources.length === 0) {
      return [];
    }
    const db = get(db$);
    const ids = [
      ...new Set(
        request.sources.map((source) => {
          return source.sourceId;
        }),
      ),
    ];
    const rows = await loadSourceRows(db, request, ids);
    const available = new Map(
      rows
        .filter((row) => {
          // Custom OAuth sources stay refreshable at runtime; their reconnect
          // state is returned as a connection fact for the caller to judge.
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
    const values = await loadSourceValues(db, request, [...available.keys()]);
    return request.sources.map((source): ConnectorSourceResult => {
      const row = available.get(source.sourceId);
      return sourceMatches(request, source, row)
        ? { kind: "available", snapshot: sourceSnapshot(source, row, values) }
        : { kind: "unavailable", source };
    });
  });
}
