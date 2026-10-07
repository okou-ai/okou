import {
  AUTO_RUN_KEY_VENDOR,
  AUTO_RUN_MODEL,
  AUTO_RUN_PROVIDER,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";

import { and, eq, gt } from "drizzle-orm";

import { nowDate } from "../../lib/time";
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
 * as a missing key or a cooldown) or the model is not Auto.
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

/** Resolves the Auto route when its key exists and it is not cooling down. */
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
  const cooldowns = await db
    .select({
      modelRuntimeProvider: builtInModelCandidateCooldown.modelRuntimeProvider,
      modelRuntimeModel: builtInModelCandidateCooldown.modelRuntimeModel,
    })
    .from(builtInModelCandidateCooldown)
    .where(
      and(
        eq(builtInModelCandidateCooldown.selectedModel, selectedModel),
        eq(
          builtInModelCandidateCooldown.modelRuntimeProvider,
          AUTO_RUN_PROVIDER,
        ),
        gt(builtInModelCandidateCooldown.unavailableUntil, nowDate()),
      ),
    );
  return builtInModelRuntimeRouteFromSnapshot({
    catalog,
    selectedModel,
    modelKeyId,
    cooldowns,
  });
}

/** Chooses the Auto route from one batched key and cooldown snapshot. */
export function builtInModelRuntimeRouteFromSnapshot(args: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly modelKeyId: string | undefined;
  readonly cooldowns: readonly {
    readonly modelRuntimeProvider: string;
    readonly modelRuntimeModel: string;
  }[];
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
  const cooled = args.cooldowns.some((cooldown) => {
    return (
      cooldown.modelRuntimeProvider === AUTO_RUN_PROVIDER &&
      cooldown.modelRuntimeModel === upstreamModel
    );
  });
  return cooled
    ? null
    : {
        selectedModel: AUTO_RUN_MODEL,
        providerType: AUTO_RUN_PROVIDER,
        upstreamModel,
        modelKeyId: args.modelKeyId,
      };
}
