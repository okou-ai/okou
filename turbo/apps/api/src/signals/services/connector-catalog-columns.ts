import { sql } from "drizzle-orm";
import { connectorCatalogEntries } from "@okouai/db/schema/connector-catalog";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ConnectorCatalogPermissionSummary } from "@okouai/connectors/connector-catalog/entry-columns";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";

// Release 1: an outgoing API can still insert payload-only entries after the
// backfill. Keep field-level SQL fallbacks until those writers and rollback
// targets have drained and their retained rows have been backfilled. Never
// transfer the complete payload to a reader. The payload contraction removes
// these expressions together with the dual writer (follow-up #37899).
const entry = connectorCatalogEntries;

export const connectorCatalogCompatibilityColumns = Object.freeze({
  slug: entry.slug,
  authMethods:
    sql`COALESCE(${entry.authMethods}, ${entry.payload} -> 'authMethods')`.mapWith(
      entry.authMethods,
    ),
  // A missing MCP descriptor is legitimate. Use a required projected field
  // as the old-writer marker so non-MCP rows do not detoast payload on reads.
  mcp: sql`CASE WHEN ${entry.authMethods} IS NOT NULL THEN ${entry.mcp} ELSE ${entry.payload} -> 'mcp' END`.mapWith(
    nullableDriverValueDecoder(entry.mcp),
  ),
});

const metadataColumns = Object.freeze({
  ...connectorCatalogCompatibilityColumns,
  label: sql`COALESCE(${entry.label}, ${entry.payload} ->> 'label')`.mapWith(
    entry.label,
  ),
  description:
    sql`COALESCE(${entry.description}, ${entry.payload} ->> 'description')`.mapWith(
      entry.description,
    ),
  category:
    sql`COALESCE(${entry.category}, ${entry.payload} ->> 'category')`.mapWith(
      entry.category,
    ),
  icon: sql`COALESCE(${entry.icon}, ${entry.payload} -> 'icon')`.mapWith(
    entry.icon,
  ),
  tags: sql`COALESCE(${entry.tags}, ARRAY(SELECT jsonb_array_elements_text(${entry.payload} -> 'tags')))`.mapWith(
    entry.tags,
  ),
  generation:
    sql`COALESCE(${entry.generation}, ARRAY(SELECT jsonb_array_elements_text(${entry.payload} -> 'generation')))`.mapWith(
      entry.generation,
    ),
});

// This is the same summary as the backfill and writer, evaluated only for
// payload-only rows inserted by an outgoing API during the rollout.
const legacyPermissionSummary = sql`CASE
  WHEN ${entry.payload} ? 'mcp' OR ${entry.payload} #>> '{firewall,kind}' = 'none'
  THEN jsonb_build_object(
    'hasPermissions', false, 'permissionCount', 0,
    'hasCategories', false, 'hasDefaultPolicyOverrides', false
  )
  ELSE (
    SELECT jsonb_build_object(
      'hasPermissions', count(*) > 0,
      'permissionCount', count(*),
      'hasCategories', ${entry.payload} #> '{firewall,categories}' <> 'null'::jsonb,
      'hasDefaultPolicyOverrides',
        ${entry.payload} #>> '{firewall,defaultUnknownPolicy}' <> 'allow'
        OR COALESCE(bool_or(
          ${entry.payload} #> '{firewall,defaultAllowed}' <> 'null'::jsonb
          AND NOT (${entry.payload} #> '{firewall,defaultAllowed}' ? permissions.name)
        ), false)
    )
    FROM (
      SELECT DISTINCT permission ->> 'name' AS name
      FROM jsonb_array_elements(${entry.payload} #> '{firewall,config,apis}') AS api,
        jsonb_array_elements(COALESCE(api -> 'permissions', '[]'::jsonb)) AS permission
    ) AS permissions
  )
END`;

export const connectorCatalogDisplayColumns = Object.freeze({
  ...metadataColumns,
  permissionSummary:
    sql`COALESCE(${entry.permissionSummary}, ${legacyPermissionSummary})`.mapWith(
      entry.permissionSummary,
    ),
});

export const connectorCatalogRuntimeColumns = Object.freeze({
  ...metadataColumns,
  skill: sql`COALESCE(${entry.skill}, ${entry.payload} -> 'skill')`.mapWith(
    entry.skill,
  ),
  firewall:
    sql`COALESCE(${entry.firewall}, ${entry.payload} -> 'firewall')`.mapWith(
      entry.firewall,
    ),
});

type CompatibilityConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "authMethods" | "mcp"
>;

export type ConnectorCatalogDisplayConnector = Pick<
  ConnectorCatalogArtifactConnector,
  | "slug"
  | "label"
  | "description"
  | "category"
  | "icon"
  | "tags"
  | "generation"
  | "authMethods"
  | "mcp"
> & { readonly permissionSummary: ConnectorCatalogPermissionSummary };

type ColumnRow<T extends CompatibilityConnector> = Omit<T, "mcp"> & {
  readonly mcp: NonNullable<T["mcp"]> | null;
};

export function materializeConnectorCatalogCompatibilityRow(
  row: ColumnRow<CompatibilityConnector>,
): CompatibilityConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogDisplayRow(
  row: ColumnRow<ConnectorCatalogDisplayConnector>,
): ConnectorCatalogDisplayConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}

export function materializeConnectorCatalogRuntimeRow(
  row: ColumnRow<ConnectorCatalogArtifactConnector>,
): ConnectorCatalogArtifactConnector {
  const { mcp, ...fields } = row;
  return { ...fields, ...(mcp === null ? {} : { mcp }) };
}
