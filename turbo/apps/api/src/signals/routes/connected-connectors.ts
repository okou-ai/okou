import { command, computed, type Computed } from "ccstate";
import {
  connectedConnectorsContract,
  type ConnectedConnectors,
} from "@okouai/api-contracts/contracts/connected-connectors";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  getAllFeatureStates,
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { and, eq, exists } from "drizzle-orm";

import { notFound, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { builtinConnectorAccountSlugs } from "../services/connector-account-lifecycle.service";
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
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import { chatConnectorOverview } from "../services/chat-connector-overview.service";
import { settle } from "../utils";

interface ConnectorOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly target?: ConnectorAccountTarget;
}

/** Shared member discovery policy for directory and Chat overview reads. */
function connectedConnectorBriefs(
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
          exists(
            db
              .select({ id: connectors.id })
              .from(connectors)
              .where(
                and(
                  eq(connectors.orgId, owner.orgId),
                  eq(connectors.userId, owner.userId),
                  eq(connectors.customConnectorId, orgCustomConnectors.id),
                  owner.target?.kind === "custom"
                    ? eq(
                        connectors.customConnectorId,
                        owner.target.customConnectorId,
                      )
                    : undefined,
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

const owner$ = computed((get) => {
  const { orgId, userId } = get(organizationAuthContext$);
  return { orgId, userId };
});
const context$ = createUserFeatureSwitchContext(owner$);
const connected$ = connectedConnectorBriefs(owner$, context$);
const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await settle(get(connected$));
  signal.throwIfAborted();
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw result.error;
  }
  return { status: 200 as const, body: result.value };
});

const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
const unavailable = notFound("Chat connector account access is not available");
const missing = notFound("Chat or connector account not found");
const featureAvailable$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const context = await get(context$);
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.ConnectorChatAccountAccess, context);
});

const overviewScope$ = computed((get) => {
  return {
    ...get(owner$),
    ...get(queryOf(chatConnectorAccessContract.overview)),
  };
});
const overview$ = chatConnectorOverview(
  overviewScope$,
  connectedConnectorBriefs(overviewScope$, context$),
);
const overviewTargetScope$ = computed((get) => {
  const { threadId, ...target } = get(
    queryOf(chatConnectorAccessContract.overviewTarget),
  );
  return { ...get(owner$), ...(threadId ? { threadId } : {}), target };
});
const overviewTarget$ = chatConnectorOverview(
  overviewTargetScope$,
  connectedConnectorBriefs(overviewTargetScope$, context$),
);
const overviewHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const result = await settle(get(overview$));
  signal.throwIfAborted();
  if (!result.ok) {
    if (isConnectorCatalogUnavailableError(result.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw result.error;
  }
  return result.value ? { status: 200 as const, body: result.value } : missing;
});
const overviewTargetHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(featureAvailable$, signal))) {
      return unavailable;
    }
    const result = await settle(get(overviewTarget$));
    signal.throwIfAborted();
    if (!result.ok) {
      if (isConnectorCatalogUnavailableError(result.error)) {
        return providerUnavailable(
          "Connector catalog is temporarily unavailable",
        );
      }
      throw result.error;
    }
    return result.value
      ? { status: 200 as const, body: { connector: result.value[0] ?? null } }
      : missing;
  },
);

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
  {
    route: chatConnectorAccessContract.overview,
    handler: authRoute(ownerAuth, overviewHandler$),
  },
  {
    route: chatConnectorAccessContract.overviewTarget,
    handler: authRoute(ownerAuth, overviewTargetHandler$),
  },
];
