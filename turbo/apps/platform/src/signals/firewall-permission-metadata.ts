import { computed, type Computed } from "ccstate";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import type { PlatformConnectorPermissionMetadata } from "./connector-domain.ts";
import { builtinConnectorsReloadVersion$ } from "./external/connectors.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";

interface FirewallPermissionMetadataParams {
  readonly connectorSlug: string;
}

export function firewallPermissionMetadataByConnector(
  params: FirewallPermissionMetadataParams,
): Computed<Promise<PlatformConnectorPermissionMetadata | null>> {
  const key = params.connectorSlug;
  return computed(async (get) => {
    if (!connectorSlugSchema.safeParse(key).success) {
      return null;
    }
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);

    const createClient = get(apiClient$);
    const client = createClient(connectorCatalogContract);
    const result = await accept(
      client.permissions({
        params: { connectorSlug: key },
      }),
      [200, 404],
    );
    if (result.status === 404) {
      return null;
    }
    const permissions = result.body.permissions;
    if (permissions.connectorSlug !== key) {
      throw new Error(
        `Permission metadata connector slug mismatch: expected ${key}, got ${permissions.connectorSlug}`,
      );
    }
    return permissions;
  });
}
