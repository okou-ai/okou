import { isPiRouteClass,modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { AUTO_RUN_MODEL,AUTO_RUN_PROVIDER,AUTO_RUN_UPSTREAM_MODEL } from "@okouai/core/auto-run-model";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { modelCatalog$ } from "../services/model-catalog.service";

const getModelCatalogInner$ = command(async ({ get }, signal: AbortSignal) => {
  get(organizationAuthContext$);
  const catalog = await get(modelCatalog$);
  signal.throwIfAborted();
  const routes = catalog.routes.filter((route) => route.enabled && (route.subscriptionType === "codex-oauth-token" || route.subscriptionType === "claude-code-oauth-token") && catalog.byModel.get(route.model)?.replacedBy === null);
  const personalModels = new Set(routes.map((route) => route.model));
  return {
    status: 200 as const,
    body: {
      models: [{ model: AUTO_RUN_MODEL, displayName: "Auto", sortOrder: 0, isSystemDefault: true, replacedBy: null, resolvedModel: AUTO_RUN_MODEL, priceTier: null, builtInOnRestrictedPlans: true, piRouteClass: "gpt-codex" as const }, ...catalog.models.filter((row) => personalModels.has(row.model)).map((row) => ({ model: row.model, displayName: row.displayName, sortOrder: row.sortOrder, isSystemDefault: false, replacedBy: null, resolvedModel: row.model, priceTier: null, builtInOnRestrictedPlans: false, piRouteClass: isPiRouteClass(row.piRouteClass) ? row.piRouteClass : null }))],
      routes: [{ model: AUTO_RUN_MODEL, providerType: "built-in", concreteProviderType: AUTO_RUN_PROVIDER, subscriptionType: null, upstreamModel: AUTO_RUN_UPSTREAM_MODEL, enabled: true, priority: 0, serviceTiers: [], defaultServiceTier: null, efforts: [], defaultEffort: null, priceTier: null }, ...routes.map(({ pricingKind: _kind, pricingProvider: _pricing, priceTier: _price, ...route }) => ({ ...route, serviceTiers: [...route.serviceTiers], efforts: [...route.efforts], priceTier: null }))],
      systemDefaultModel: AUTO_RUN_MODEL,
    },
  };
});
export const modelCatalogRoutes: readonly RouteEntry[] = [{ route: modelCatalogContract.get, handler: authRoute({ requireOrganization: true, missingOrganizationStatus: 401 }, getModelCatalogInner$) }];
