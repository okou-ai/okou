import {
  isPiRouteClass,
  modelCatalogContract,
} from "@okouai/api-contracts/contracts/model-catalog";
import {
  AUTO_RUN_MODEL,
  AUTO_RUN_PROVIDER,
  AUTO_RUN_UPSTREAM_MODEL,
} from "@okouai/core/auto-run-model";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import {
  modelCatalog$,
  resolveCatalogModel,
} from "../services/model-catalog.service";

const getModelCatalogInner$ = command(async ({ get }, signal: AbortSignal) => {
  get(organizationAuthContext$);
  const catalog = await get(modelCatalog$);
  signal.throwIfAborted();
  const routes = catalog.routes.filter((route) => {
    return (
      route.enabled &&
      (route.subscriptionType === "codex-oauth-token" ||
        route.subscriptionType === "claude-code-oauth-token") &&
      catalog.byModel.get(route.model)?.replacedBy === null
    );
  });
  return {
    status: 200 as const,
    body: {
      models: [
        {
          model: AUTO_RUN_MODEL,
          displayName: "Auto",
          sortOrder: 0,
          replacedBy: null,
          resolvedModel: AUTO_RUN_MODEL,
          builtInOnRestrictedPlans: true,
          piRouteClass: "gpt-codex" as const,
        },
        ...catalog.models
          .filter((row) => {
            return row.model !== AUTO_RUN_MODEL;
          })
          .map((row) => {
            const resolution = resolveCatalogModel(catalog, row.model);
            if (resolution.kind === "unknown") {
              throw new Error(
                "Catalog row disappeared during metadata projection",
              );
            }
            return {
              model: row.model,
              displayName: row.displayName,
              sortOrder: row.sortOrder,
              replacedBy: row.replacedBy,
              resolvedModel: resolution.resolvedModel,
              builtInOnRestrictedPlans: false,
              piRouteClass: isPiRouteClass(row.piRouteClass)
                ? row.piRouteClass
                : null,
            };
          }),
      ],
      routes: [
        {
          model: AUTO_RUN_MODEL,
          providerType: "built-in",
          concreteProviderType: AUTO_RUN_PROVIDER,
          subscriptionType: null,
          upstreamModel: AUTO_RUN_UPSTREAM_MODEL,
          enabled: true,
          priority: 0,
          serviceTiers: [],
          defaultServiceTier: null,
          efforts: [],
          defaultEffort: null,
        },
        ...routes.map(
          ({ pricingKind: _kind, pricingProvider: _pricing, ...route }) => {
            return {
              ...route,
              serviceTiers: [...route.serviceTiers],
              efforts: [...route.efforts],
            };
          },
        ),
      ],
      systemDefaultModel: AUTO_RUN_MODEL,
    },
  };
});
export const modelCatalogRoutes: readonly RouteEntry[] = [
  {
    route: modelCatalogContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        acceptAnySandboxCapability: true,
      },
      getModelCatalogInner$,
    ),
  },
];
