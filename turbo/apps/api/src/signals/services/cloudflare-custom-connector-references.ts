import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorCloudflareBindings } from "@okouai/db/schema/org-custom-connector-cloudflare-binding";
import { and, asc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { enum as zEnum } from "zod";
import {
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";

const connectorKindDecoder = zodEnumDriverValueDecoder(zEnum(["http", "mcp"]));

/** Organization definitions are not personally owned SSH/VNC hosts. */
export function cloudflareCustomConnectorReferencesQuery(
  orgId: string,
  configId?: string | SQLWrapper,
  enabled = true,
) {
  const binding = orgCustomConnectorCloudflareBindings;
  const connector = orgCustomConnectors;
  return new QueryBuilder()
    .select({
      id: connector.id,
      configId: binding.configId,
      displayName: connector.displayName,
      kind: sql`CASE WHEN ${connector.mcpEndpoint} IS NULL THEN 'http' ELSE 'mcp' END`
        .mapWith(connectorKindDecoder)
        .as("connector_kind"),
      storageVersion: sql`${connector.storageVersion}::text`
        .mapWith(pgTextDecoder)
        .as("connector_storage_version"),
    })
    .from(binding)
    .innerJoin(
      connector,
      and(
        eq(connector.id, binding.connectorId),
        eq(connector.orgId, binding.orgId),
      ),
    )
    .where(
      and(
        eq(binding.orgId, orgId),
        configId === undefined ? undefined : eq(binding.configId, configId),
        enabled ? undefined : sql`false`,
      ),
    )
    .orderBy(asc(connector.id));
}
