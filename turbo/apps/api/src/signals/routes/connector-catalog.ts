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
  discoverPublicConnectorCatalogStatus,
  publicConnectorCatalogPermissionDetail,
  isConnectorCatalogUnavailableError,
  connectorBriefsFromRows,
  listConnectorCatalogConnectItems,
  listPublicConnectorCatalog,
  listPublicConnectorCatalogStatus,
} from "../services/connector-catalog-reader.service";
import {
  connectorCatalogDisplayColumns,
  materializeConnectorCatalogDisplayRow,
} from "../services/connector-catalog-columns";
import { publicConnectorCatalogStatusFromSource } from "../services/connector-catalog-external-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugSourceFromRows,
} from "../services/connector-catalog-slug-source.service";
import { builtinConnectorCatalogConnectionList } from "../services/connector-data.service";
import { notFound, providerUnavailable } from "../../lib/error";
import { settle } from "../utils";

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

    const catalog = await settleConnectorCatalogRead(
      listPublicConnectorCatalog({
        db: context.db,
        featureStates: context.featureStates,
      }),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

const listConnectorCatalogStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        builtinConnectorCatalogConnectionList({
          orgId: auth.orgId,
          userId: auth.userId,
        }),
      ),
      signal,
    );
    if (!connectorState.ok) {
      return connectorCatalogUnavailable();
    }
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      listPublicConnectorCatalogStatus({
        db: context.db,
        featureStates: context.featureStates,
        connections: connectorState.value,
      }),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

/**
 * Connect items for a connect surface, joined with the caller's connections.
 * Shared by the one-click picker and the onboarding sources.
 */
export const listConnectorCatalogConnectItems$ = command(
  async (
    { get, set },
    filter:
      | {
          readonly kind: "slugs";
          readonly connectorSlugs: readonly ConnectorSlug[];
        }
      | { readonly kind: "one-click" },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        builtinConnectorCatalogConnectionList({
          orgId: auth.orgId,
          userId: auth.userId,
        }),
      ),
      signal,
    );
    if (!connectorState.ok) {
      return connectorCatalogUnavailable();
    }
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      listConnectorCatalogConnectItems({
        db: context.db,
        featureStates: context.featureStates,
        connections: connectorState.value,
        filter,
      }),
      signal,
    );
    if (!catalog.ok) {
      return connectorCatalogUnavailable();
    }

    return { status: 200 as const, body: catalog.value };
  },
);

/**
 * Label and icon for a named set of connectors, read from the per-connector
 * projection without the caller's connection status.
 */
export const listConnectorCatalogBriefs$ = command(
  async (
    { get },
    connectorSlugs: readonly ConnectorSlug[],
    signal: AbortSignal,
  ) => {
    const featureStates = getAllFeatureStates(
      await get(connectorCatalogFeatureContext$),
    );
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      connectorSlugs.length === 0
        ? Promise.resolve([])
        : (async () => {
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
                connectorCatalogSlugJoin(connectorSlugs),
              )
              .where(connectorCatalogCurrentWhere());
            return connectorBriefsFromRows({
              rows,
              featureStates,
              connectorSlugs,
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
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(connectorCatalogContract.discovery));
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        builtinConnectorCatalogConnectionList({
          orgId: auth.orgId,
          userId: auth.userId,
        }),
      ),
      signal,
    );
    if (!connectorState.ok) {
      return connectorCatalogUnavailable();
    }
    signal.throwIfAborted();

    const catalog = await settleConnectorCatalogRead(
      discoverPublicConnectorCatalogStatus({
        db: context.db,
        featureStates: context.featureStates,
        connections: connectorState.value,
        keyword: query.keyword,
        category: query.category,
      }),
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
    const auth = get(organizationAuthContext$);
    const featureStates = getAllFeatureStates(
      await get(connectorCatalogFeatureContext$),
    );
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        builtinConnectorCatalogConnectionList({
          orgId: auth.orgId,
          userId: auth.userId,
        }),
      ),
      signal,
    );
    if (!connectorState.ok) {
      return connectorCatalogUnavailable();
    }
    signal.throwIfAborted();

    const params = get(pathParamsOf(connectorCatalogContract.get));
    const connector = await settleConnectorCatalogRead(
      (async () => {
        const catalog = await get(connectorCatalogStatusSource$);
        return publicConnectorCatalogStatusFromSource({
          catalog,
          connectorSlug: params.connectorSlug,
          featureStates,
          connections: connectorState.value,
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
