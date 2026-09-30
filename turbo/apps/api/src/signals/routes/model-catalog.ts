import { command } from "ccstate";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  loadModelCatalog,
  resolveCatalogModel,
} from "../services/model-catalog.service";

const getModelCatalogInner$ = command(async ({ get }, signal: AbortSignal) => {
  get(organizationAuthContext$);
  const catalog = await loadModelCatalog(get(db$));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      models: catalog.models.map((row) => {
        const resolution = resolveCatalogModel(catalog, row.model);
        return {
          ...row,
          resolvedModel:
            resolution.kind === "replaced"
              ? resolution.resolvedModel
              : row.model,
        };
      }),
      routes: catalog.routes.map((route) => {
        return {
          ...route,
          serviceTiers: [...route.serviceTiers],
          efforts: [...route.efforts],
        };
      }),
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
