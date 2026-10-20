import { command, computed } from "ccstate";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq, exists, isNotNull } from "drizzle-orm";

import { providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { connectorCatalogDisplayColumns } from "../services/connector-catalog-columns";
import {
  connectorBriefsFromRows,
  isConnectorCatalogUnavailableError,
} from "../services/connector-catalog-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
} from "../services/connector-catalog-slug-source.service";
import { effectiveCustomConnectorPermissionBundleRef } from "../services/feishu-custom-connector-permissions";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { settle } from "../utils";

const builtinSlugs$ = computed(async (get) => {
  const owner = get(organizationAuthContext$);
  const db = get(db$);
  const rows = await db
    .selectDistinct({ connectorSlug: connectors.connectorSlug })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, owner.orgId),
        eq(connectors.userId, owner.userId),
        isNotNull(connectors.connectorSlug),
      ),
    );
  return rows.map((row) => {
    return connectorSlugSchema.parse(row.connectorSlug);
  });
});

const builtinBriefs$ = computed(async (get) => {
  const owner = get(organizationAuthContext$);
  const [slugs, overrides] = await Promise.all([
    get(builtinSlugs$),
    get(userFeatureSwitchOverrides(owner.orgId, owner.userId)),
  ]);
  if (slugs.length === 0) {
    return [];
  }
  const db = get(db$);
  const rows = await db
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
    featureStates: getAllFeatureStates({
      orgId: owner.orgId,
      userId: owner.userId,
      overrides,
    }),
    connectorSlugs: slugs,
  });
});

const customBriefs$ = computed(async (get) => {
  const owner = get(organizationAuthContext$);
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
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.orgId, owner.orgId),
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

const connected$ = computed(async (get) => {
  const result = await settle(
    Promise.all([get(builtinBriefs$), get(customBriefs$)]),
  );
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw result.error;
  }
  const [builtinConnectors, customConnectors] = result.value;
  return {
    status: 200 as const,
    body: { builtinConnectors, customConnectors },
  };
});

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await get(connected$);
  signal.throwIfAborted();
  return result;
});

export const connectedConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: connectedConnectorsContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      list$,
    ),
  },
];
