import { customConnectorNetworkMetadataSchema } from "@okouai/api-contracts/validators/custom-connector-network";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorCloudflareBindings } from "@okouai/db/schema/org-custom-connector-cloudflare-binding";
import { and, eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";

/** Read the org-owned network separately from the member's application account. */
export function customConnectorNetworkBindingSelection() {
  const binding = orgCustomConnectorCloudflareBindings;
  const config = cloudflareAccessConfigs;
  const query = new QueryBuilder()
    .select({
      metadata: sql`jsonb_build_object(
      'type', 'cloudflare_access',
      'configId', ${binding.configId},
      'status', 'available',
      'name', ${config.name}
    )`,
    })
    .from(binding)
    .innerJoin(
      config,
      and(
        eq(config.id, binding.configId),
        eq(config.orgId, binding.orgId),
        eq(config.scope, "organization"),
      ),
    )
    .where(
      and(
        eq(binding.connectorId, orgCustomConnectors.id),
        eq(binding.orgId, orgCustomConnectors.orgId),
      ),
    );
  return sql`(${query})`.mapWith(
    zodDriverValueDecoder(customConnectorNetworkMetadataSchema.nullable()),
  );
}
