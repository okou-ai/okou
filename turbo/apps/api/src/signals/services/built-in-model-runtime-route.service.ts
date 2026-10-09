import {
  isAutoSelectedModel,
  AUTO_RUN_PROVIDER,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import {
  builtInRoutePricingRejectionMessage,
  unpricedBuiltInRouteCategories,
  type BuiltInRoutePricing,
} from "./built-in-route-pricing";
import { catalogAutoRoute, type ModelCatalog } from "./model-catalog.service";

/**
 * The single platform route, Auto on managed OpenRouter, when the selected
 * model is Auto, its preset is valid, and (for a new run) it is fully priced.
 */
export function catalogBuiltInModelRouteUpstream(
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing?: BuiltInRoutePricing,
): string | null {
  const route = catalogAutoRoute(catalog, selectedModel);
  if (!route || !isAutoRunPreset(route.upstreamModel)) {
    return null;
  }
  if (
    routePricing &&
    unpricedBuiltInRouteCategories(routePricing, route).length > 0
  ) {
    return null;
  }
  return route.upstreamModel;
}

/**
 * The rejection for a new Auto run whose usage categories are not all priced;
 * null when the route is priced (and so unavailable for another reason, such
 * as a missing key) or the model is not Auto.
 */
export function unpricedBuiltInModelMessage(
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing: BuiltInRoutePricing,
): string | null {
  const route = catalogAutoRoute(catalog, selectedModel);
  if (!route) {
    return null;
  }
  const categories = unpricedBuiltInRouteCategories(routePricing, route);
  return categories.length === 0
    ? null
    : builtInRoutePricingRejectionMessage(selectedModel, categories);
}

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: typeof AUTO_RUN_PROVIDER;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

/** Captured Auto presets survive later operator edits, never vendor changes. */
export function isBuiltInModelRuntimeRoutePermitted(
  route: BuiltInModelRuntimeRoute,
): boolean {
  return (
    isAutoSelectedModel(route.selectedModel) &&
    route.providerType === AUTO_RUN_PROVIDER &&
    isAutoRunPreset(route.upstreamModel)
  );
}

/** Chooses the Auto route from one batched key snapshot. */
export function builtInModelRuntimeRouteFromSnapshot(args: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly modelKeyId: string | undefined;
  /** A new run's route pricing; an unpriced route is unavailable. */
  readonly routePricing?: BuiltInRoutePricing;
}): BuiltInModelRuntimeRoute | null {
  const upstreamModel = catalogBuiltInModelRouteUpstream(
    args.catalog,
    args.selectedModel,
    args.routePricing,
  );
  if (upstreamModel === null || args.modelKeyId === undefined) {
    return null;
  }
  return {
    selectedModel: args.selectedModel,
    providerType: AUTO_RUN_PROVIDER,
    upstreamModel,
    modelKeyId: args.modelKeyId,
  };
}
