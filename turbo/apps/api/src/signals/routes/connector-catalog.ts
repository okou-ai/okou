import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { connectorCatalogDiagnostics$ } from "../services/connector-catalog-diagnostics.service";
import {
  discoverPublicConnectorCatalogStatus,
  getPublicConnectorCatalogStatus,
  getPublicConnectorCatalogPermissionDetail,
  isConnectorCatalogUnavailableError,
  listPublicConnectorCatalog,
  listPublicConnectorCatalogStatus,
} from "../services/connector-catalog-reader.service";
import { connectorCatalogConnectionList } from "../services/connector-data.service";
import { notFound, providerUnavailable } from "../../lib/error";
import { settle } from "../utils";

const connectorCatalogAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const connectorCatalogDiagnosticsAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const connectorCatalogDiagnosticsDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Connector catalog diagnostics are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

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
        connectorCatalogConnectionList({
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

const discoverConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(connectorCatalogContract.discovery));
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        connectorCatalogConnectionList({
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

const getConnectorCatalogDiagnosticsInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();
    if (!context.featureStates[FeatureSwitchKey.OkouDebug]) {
      return connectorCatalogDiagnosticsDisabled;
    }

    const diagnostics = await set(connectorCatalogDiagnostics$, signal);
    return { status: 200 as const, body: diagnostics };
  },
);

const getConnectorCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const connectorState = await settleConnectorCatalogRead(
      get(
        connectorCatalogConnectionList({
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
      getPublicConnectorCatalogStatus({
        db: context.db,
        connectorSlug: params.connectorSlug,
        featureStates: context.featureStates,
        connections: connectorState.value,
      }),
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

const getConnectorCatalogPermissionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const context = await set(connectorCatalogRequestContext$);
    signal.throwIfAborted();

    const params = get(pathParamsOf(connectorCatalogContract.permissions));
    const permissions = await settleConnectorCatalogRead(
      getPublicConnectorCatalogPermissionDetail({
        db: context.db,
        connectorSlug: params.connectorSlug,
        featureStates: context.featureStates,
      }),
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
    route: connectorCatalogContract.diagnostics,
    handler: authRoute(
      connectorCatalogDiagnosticsAuth,
      getConnectorCatalogDiagnosticsInner$,
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
