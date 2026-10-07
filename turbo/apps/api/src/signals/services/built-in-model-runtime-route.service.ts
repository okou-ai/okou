import {
  AUTO_RUN_KEY_VENDOR,
  AUTO_RUN_MODEL,
  AUTO_RUN_PROVIDER,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";

import { eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
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
  _catalog: ModelCatalog,
  route: BuiltInModelRuntimeRoute,
): boolean {
  return (
    route.selectedModel === AUTO_RUN_MODEL &&
    route.providerType === AUTO_RUN_PROVIDER &&
    isAutoRunPreset(route.upstreamModel)
  );
}

async function loadBuiltInModelKeyId(
  db: ReadonlyDb,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: builtInModelKeys.id })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, AUTO_RUN_KEY_VENDOR))
    .limit(1);
  return row?.id;
}

/** Resolves the Auto route when its key exists. */
export async function resolveBuiltInModelRuntimeRoute(
  catalog: ModelCatalog,
  db: ReadonlyDb,
  selectedModel: string,
): Promise<BuiltInModelRuntimeRoute | null> {
  const upstreamModel = catalogBuiltInModelRouteUpstream(
    catalog,
    selectedModel,
  );
  if (upstreamModel === null) {
    return null;
  }
  const modelKeyId = await loadBuiltInModelKeyId(db);
  if (modelKeyId === undefined) {
    return null;
  }
  return builtInModelRuntimeRouteFromSnapshot({
    catalog,
    selectedModel,
    modelKeyId,
  });
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
    selectedModel: AUTO_RUN_MODEL,
    providerType: AUTO_RUN_PROVIDER,
    upstreamModel,
    modelKeyId: args.modelKeyId,
  };
}
