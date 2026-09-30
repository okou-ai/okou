import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { db$ } from "../external/db";

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
  readonly name: string;
  readonly encryptedValue: string;
}
export interface ConnectorSourceSnapshot {
  readonly source: ConnectorSourceIdentity;
  readonly variables: Readonly<Record<string, string>>;
  readonly credentials: readonly EncryptedConnectorCredential[];
}
export type ConnectorSourceResult =
  | { readonly kind: "available"; readonly snapshot: ConnectorSourceSnapshot }
  | { readonly kind: "unavailable"; readonly source: ConnectorSourceIdentity };

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
    const rows = await db
      .select({
        id: connectors.id,
        connectorSlug: connectors.connectorSlug,
        customConnectorId: connectors.customConnectorId,
        needsReconnect: connectors.needsReconnect,
        authMethod: connectors.authMethod,
        customOrgId: orgCustomConnectors.orgId,
        customEnabled: orgCustomConnectors.enabled,
      })
      .from(connectors)
      .leftJoin(
        orgCustomConnectors,
        eq(orgCustomConnectors.id, connectors.customConnectorId),
      )
      .where(
        and(
          eq(connectors.orgId, request.orgId),
          eq(connectors.userId, request.userId),
          inArray(connectors.id, ids),
        ),
      );
    const available = new Map(
      rows
        .filter((row) => {
          return !row.needsReconnect || row.authMethod === "none";
        })
        .map((row) => {
          return [row.id, row];
        }),
    );
    const availableIds = [...available.keys()];
    const [storedVariables, storedCredentials] =
      availableIds.length === 0
        ? [[], []]
        : await Promise.all([
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
                  inArray(variables.connectorId, availableIds),
                ),
              ),
            db
              .select({
                sourceId: secrets.connectorId,
                name: secrets.name,
                encryptedValue: secrets.encryptedValue,
              })
              .from(secrets)
              .where(
                and(
                  eq(secrets.orgId, request.orgId),
                  eq(secrets.userId, request.userId),
                  eq(secrets.type, "connector"),
                  inArray(secrets.connectorId, availableIds),
                ),
              ),
          ]);
    return request.sources.map((source): ConnectorSourceResult => {
      const row = available.get(source.sourceId);
      const matches =
        row !== undefined &&
        (source.kind === "builtin"
          ? row.connectorSlug === source.connectorSlug &&
            row.customConnectorId === null
          : row.customConnectorId === source.customConnectorId &&
            row.customOrgId === request.orgId &&
            row.customEnabled === true);
      if (!matches) {
        return { kind: "unavailable", source };
      }
      return {
        kind: "available",
        snapshot: {
          source,
          variables: Object.fromEntries(
            storedVariables
              .filter((value) => {
                return value.sourceId === source.sourceId;
              })
              .map((value) => {
                return [value.name, value.value];
              }),
          ),
          credentials: storedCredentials
            .filter((value) => {
              return value.sourceId === source.sourceId;
            })
            .map(({ name, encryptedValue }) => {
              return { name, encryptedValue };
            }),
        },
      };
    });
  });
}
