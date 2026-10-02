import { command } from "ccstate";
import {
  isPiRouteClass,
  modelCatalogContract,
} from "@okouai/api-contracts/contracts/model-catalog";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";

import type { RouteEntry } from "../route-entry";
import {
  catalogBuiltInPriceTier,
  resolveCatalogModel,
  modelCatalog$,
} from "../services/model-catalog.service";

const getModelCatalogInner$ = command(async ({ get }, signal: AbortSignal) => {
  get(organizationAuthContext$);
  const catalog = await get(modelCatalog$);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      models: catalog.models.map((row) => {
        const resolution = resolveCatalogModel(catalog, row.model);
        return {
          model: row.model,
          displayName: row.displayName,
          sortOrder: row.sortOrder,
          isSystemDefault: row.isSystemDefault,
          replacedBy: row.replacedBy,
          resolvedModel:
            resolution.kind === "unknown"
              ? row.model
              : resolution.resolvedModel,
          priceTier: catalogBuiltInPriceTier(catalog, row.model),
          builtInOnRestrictedPlans: row.builtInOnRestrictedPlans,
          piRouteClass: isPiRouteClass(row.piRouteClass)
            ? row.piRouteClass
            : null,
        };
      }),
      routes: catalog.routes.map((route) => {
        // The pricing link is internal billing identity, not client data.
        const {
          pricingKind: _pricingKind,
          pricingProvider: _pricingProvider,
          ...publicRoute
        } = route;
        return {
          ...publicRoute,
          serviceTiers: [...route.serviceTiers],
          efforts: [...route.efforts],
        };
      }),
      systemDefaultModel: catalog.systemDefault.model,
    },
  };
});

export const modelCatalogRoutes: readonly RouteEntry[] = [
  {
    route: modelCatalogContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getModelCatalogInner$,
    ),
  },
];
