import { computed, type Computed } from "ccstate";
import type { ConnectedConnectors } from "@okouai/api-contracts/contracts/connected-connectors";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq, exists, sql } from "drizzle-orm";

import { db$ } from "../external/db";
import { builtinConnectorAccountSlugs } from "./connector-account-lifecycle.service";
import { connectorCatalogDisplayColumns } from "./connector-catalog-columns";
import { connectorBriefsFromRows } from "./connector-catalog-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
} from "./connector-catalog-slug-source.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";

interface ConnectorOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly target?: ConnectorAccountTarget;
}

/** Shared member discovery policy for directory and Chat overview reads. */
export function connectedConnectorBriefs(
  owner$: Computed<ConnectorOwner>,
  context$: Computed<Promise<FeatureSwitchContext>>,
) {
  const builtinSlugs$ = builtinConnectorAccountSlugs(owner$);
  const builtinBriefs$ = computed(async (get) => {
    const owner = get(owner$);
    if (owner.target?.kind === "custom") {
      return [];
    }
    const [saved, context] = await Promise.all([
      get(builtinSlugs$),
      get(context$),
    ]);
    const target = owner.target;
    const slugs = target
      ? saved.filter((slug) => {
          return slug === target.connectorSlug;
        })
      : saved;
    if (slugs.length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        current: {
          schemaVersion: connectorCatalog.schemaVersion,
          hash: connectorCatalog.hash,
        },
        entry: connectorCatalogDisplayColumns,
      })
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, connectorCatalogSlugJoin(slugs))
      .where(connectorCatalogCurrentWhere());
    return connectorBriefsFromRows({
      rows,
      featureStates: getAllFeatureStates(context),
      connectorSlugs: slugs,
    });
  });
  const customBriefs$ = computed(async (get) => {
    const owner = get(owner$);
    if (owner.target?.kind === "builtin") {
      return [];
    }
    const db = get(db$);
    const rows = await db
      .select({
        id: orgCustomConnectors.id,
        slug: orgCustomConnectors.slug,
        displayName: orgCustomConnectors.displayName,
        permissionBundleRef: orgCustomConnectors.permissionBundleRef,
        authMode: orgCustomConnectors.authMode,
        prefixTemplates: orgCustomConnectors.prefixTemplates,
        oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.orgId, owner.orgId),
          owner.target
            ? eq(orgCustomConnectors.id, owner.target.customConnectorId)
            : sql`true`,
          exists(
            db
              .select({ id: connectors.id })
              .from(connectors)
              .where(
                and(
                  eq(connectors.orgId, owner.orgId),
                  eq(connectors.userId, owner.userId),
                  eq(connectors.customConnectorId, orgCustomConnectors.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(orgCustomConnectors.displayName);
    return rows.map((row) => {
      return {
        id: row.id,
        slug: row.slug,
        displayName: row.displayName,
        permissionBundleRef: effectiveCustomConnectorPermissionBundleRef(row),
        integrationManaged: isIntegrationManagedCustomConnectorProviderAdapter(
          row.oauthProviderAdapter,
        ),
      };
    });
  });
  return computed(async (get): Promise<ConnectedConnectors> => {
    const [builtinConnectors, customConnectors] = await Promise.all([
      get(builtinBriefs$),
      get(customBriefs$),
    ]);
    return { builtinConnectors: [...builtinConnectors], customConnectors };
  });
}
