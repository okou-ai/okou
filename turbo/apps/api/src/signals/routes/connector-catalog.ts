import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  createUserFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "../services/feature-switches.service";
import {
  publicConnectorCatalogPermissionDetail,
  isConnectorCatalogUnavailableError,
} from "../services/connector-catalog-reader.service";
import {
  connectorCatalogDisplayColumns,
  materializeConnectorCatalogDisplayRow,
  type ConnectorCatalogDisplayConnector,
} from "../services/connector-catalog-columns";
import {
  catalogSource,
  listExternalPublicConnectorCatalogStatus,
  connectorCatalogConnectItemsFromSource,
  listExternalPublicConnectorCatalog,
  discoverExternalPublicConnectorCatalogStatus,
  loadAcceptedConnectorCatalogSnapshot,
  publicConnectorCatalogStatusFromSource,
  type ConnectorCatalogSlugSource,
} from "../services/connector-catalog-external-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugSourceFromRows,
} from "../services/connector-catalog-slug-source.service";
import { notFound, providerUnavailable } from "../../lib/error";
import { settle } from "../utils";
import { builtinConnectorAccountSlugs } from "../services/connector-account-lifecycle.service";

const savedBuiltinSlugs$ = builtinConnectorAccountSlugs(
  organizationAuthContext$,
);

export const connectorCatalogAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

function connectorCatalogNotFound() {
  return notFound("Connector catalog item not found");
}

function connectorCatalogUnavailable() {
  return providerUnavailable("Connector catalog is temporarily unavailable");
}

async function settleConnectorCatalogRead<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  const result = await settle(read, signal);
  if (result.ok) {
    return result;
  }
  if (isConnectorCatalogUnavailableError(result.error)) {
    return { ok: false };
  }
  throw result.error;
}

const connectorCatalogRequestContext$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const featureSwitchContext = {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  };
  return {
    db: get(db$),
    featureStates: getAllFeatureStates(featureSwitchContext),
  };
});

const listConnectorCatalogInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const catalogReadDb = context.db;
    const catalogReadFeatureStates = context.featureStates;
    const catalog = await settleConnectorCatalogRead(
      (async () => {
        return await listExternalPublicConnectorCatalog({
          db: catalogReadDb,
          featureStates: catalogReadFeatureStates,
        });
      })(),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

const listConnectorCatalogStatusInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const catalogStatusDb = context.db;
    const catalogStatusFeatureStates = context.featureStates;
    const catalog = await settleConnectorCatalogRead(
      (async () => {
        const read = await listExternalPublicConnectorCatalogStatus({
          db: catalogStatusDb,
          featureStates: catalogStatusFeatureStates,
          referenceConnectorSlugs: [],
        });
        return read.status;
      })(),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

/**
 * Metadata for connect surfaces.
 * Shared by the one-click picker and the onboarding sources.
 */
export const listConnectorCatalogConnectItems$ = command(
  async (
    { set },
    filter:
      | {
          readonly kind: "slugs";
          readonly connectorSlugs: readonly ConnectorSlug[];
        }
      | { readonly kind: "one-click" },
    signal: AbortSignal,
  ) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      (async () => {
        const catalogDb = context.db;
        const featureStates = context.featureStates;
        let source: ConnectorCatalogSlugSource<ConnectorCatalogDisplayConnector>;
        if (filter.kind === "slugs") {
          const slugs = filter.connectorSlugs;
          if (slugs.length === 0) {
            source = { connectors: [], filteredMethodKeys: new Set<string>() };
          } else {
            const rows = await catalogDb
              .select({
                current: {
                  schemaVersion: connectorCatalog.schemaVersion,
                  hash: connectorCatalog.hash,
                },
                entry: connectorCatalogDisplayColumns,
              })
              .from(connectorCatalog)
              .leftJoin(
                connectorCatalogEntries,
                connectorCatalogSlugJoin(slugs),
              )
              .where(connectorCatalogCurrentWhere());
            source = connectorCatalogSlugSourceFromRows(
              rows.map((row) => {
                return {
                  current: row.current,
                  entry:
                    row.entry === null
                      ? null
                      : materializeConnectorCatalogDisplayRow(row.entry),
                };
              }),
              slugs,
            );
          }
        } else {
          source = catalogSource(
            await loadAcceptedConnectorCatalogSnapshot(
              catalogDb,
              undefined,
              "display",
            ),
          );
        }
        return connectorCatalogConnectItemsFromSource({
          catalog: source,
          featureStates,
          oneClickOnly: filter.kind === "one-click",
        });
      })(),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

const listOneClickConnectorCatalogInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(
      listConnectorCatalogConnectItems$,
      { kind: "one-click" },
      signal,
    );
  },
);

const discoverConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(connectorCatalogContract.discovery));
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    const savedConnectorSlugs = await get(savedBuiltinSlugs$);
    signal.throwIfAborted();

    const catalogDiscoveryDb = context.db;
    const catalogDiscoveryFeatureStates = context.featureStates;
    const catalogDiscoveryKeyword = query.keyword;
    const catalogDiscoveryCategory = query.category;
    const catalog = await settleConnectorCatalogRead(
      (async () => {
        const read = await discoverExternalPublicConnectorCatalogStatus({
          db: catalogDiscoveryDb,
          featureStates: catalogDiscoveryFeatureStates,
          savedConnectorSlugs,
          keyword: catalogDiscoveryKeyword,
          category: catalogDiscoveryCategory,
          referenceConnectorSlugs: [],
        });
        return read.status;
      })(),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

const connectorCatalogStatusSource$ = computed(async (get) => {
  const { connectorSlug } = get(pathParamsOf(connectorCatalogContract.get));
  const rows = await get(db$)
    .select({
      current: {
        schemaVersion: connectorCatalog.schemaVersion,
        hash: connectorCatalog.hash,
      },
      entry: connectorCatalogDisplayColumns,
    })
    .from(connectorCatalog)
    .leftJoin(
      connectorCatalogEntries,
      connectorCatalogSlugJoin([connectorSlug]),
    )
    .where(connectorCatalogCurrentWhere());
  return connectorCatalogSlugSourceFromRows(
    rows.map((row) => {
      return {
        current: row.current,
        entry:
          row.entry === null
            ? null
            : materializeConnectorCatalogDisplayRow(row.entry),
      };
    }),
    [connectorSlug],
  );
});

const getConnectorCatalogInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const featureStates = getAllFeatureStates(
      await get(connectorCatalogFeatureContext$),
    );
    signal.throwIfAborted();

    const params = get(pathParamsOf(connectorCatalogContract.get));
    const connector = await settleConnectorCatalogRead(
      (async () => {
        const catalog = await get(connectorCatalogStatusSource$);
        return publicConnectorCatalogStatusFromSource({
          catalog,
          connectorSlug: params.connectorSlug,
          featureStates,
        });
      })(),
      signal,
    );
    if (!connector.ok) {
      return connectorCatalogUnavailable();
    }
    if (!connector.value) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { connector: connector.value } };
  },
);

const connectorCatalogIdentity$ = computed((get) => {
  const { orgId, userId } = get(organizationAuthContext$);
  return Promise.resolve({ orgId, userId });
});
const connectorCatalogFeatureContext$ = createUserFeatureSwitchContext(
  connectorCatalogIdentity$,
);

const connectorCatalogPermissionsScope$ = computed(async (get) => {
  const featureContext = await get(connectorCatalogFeatureContext$);
  const params = get(pathParamsOf(connectorCatalogContract.permissions));
  return {
    connectorSlug: params.connectorSlug,
    featureStates: getAllFeatureStates(featureContext),
  };
});

const connectorCatalogPermissions$ = publicConnectorCatalogPermissionDetail(
  connectorCatalogPermissionsScope$,
);

const getConnectorCatalogPermissionsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    await get(connectorCatalogPermissionsScope$);
    signal.throwIfAborted();

    const permissions = await settleConnectorCatalogRead(
      get(connectorCatalogPermissions$),
      signal,
    );
    if (!permissions.ok) {
      return connectorCatalogUnavailable();
    }
    if (!permissions.value) {
      return connectorCatalogNotFound();
    }

    return { status: 200 as const, body: { permissions: permissions.value } };
  },
);

export const connectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: connectorCatalogContract.list,
    handler: authRoute(connectorCatalogAuth, listConnectorCatalogInner$),
  },
  {
    route: connectorCatalogContract.status,
    handler: authRoute(connectorCatalogAuth, listConnectorCatalogStatusInner$),
  },
  {
    route: connectorCatalogContract.discovery,
    handler: authRoute(connectorCatalogAuth, discoverConnectorCatalogInner$),
  },
  {
    route: connectorCatalogContract.oneClick,
    handler: authRoute(
      connectorCatalogAuth,
      listOneClickConnectorCatalogInner$,
    ),
  },
  {
    route: connectorCatalogContract.get,
    handler: authRoute(connectorCatalogAuth, getConnectorCatalogInner$),
  },
  {
    route: connectorCatalogContract.permissions,
    handler: authRoute(
      connectorCatalogAuth,
      getConnectorCatalogPermissionsInner$,
    ),
  },
];
