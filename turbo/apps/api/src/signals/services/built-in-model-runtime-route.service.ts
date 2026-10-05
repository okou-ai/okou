import {
BUILT_IN_MODEL_ROUTE_PROVIDERS,
type BuiltInModelRouteProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { AUTO_RUN_MODEL,AUTO_RUN_PROVIDER,AUTO_RUN_UPSTREAM_MODEL } from "@okouai/core/auto-run-model";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { computed,type Computed } from "ccstate";
import { and,eq,gt,inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$,type ReadonlyDb } from "../external/db";
import {
builtInRoutePricingRejectionMessage,
isBuiltInRoutePriced,
unpricedBuiltInRouteCategories,
type BuiltInRoutePricing,
} from "./built-in-route-pricing";
import {
catalogBuiltInCandidates,
type ModelCatalog,
} from "./model-catalog.service";

/** One enabled Built-in `model_routes` candidate with a known adapter. */
interface BuiltInModelRouteTarget {
  readonly selectedModel: string;
  readonly providerType: BuiltInModelRouteProviderType;
  readonly upstreamModel: string;
  readonly vendor: string;
}

function isBuiltInModelRouteProviderType(
  value: string,
): value is BuiltInModelRouteProviderType {
  return value in BUILT_IN_MODEL_ROUTE_PROVIDERS;
}

/**
 * Built-in candidates come from the catalog's enabled `built-in` routes in
 * priority order. The concrete provider's protocol adapter (vendor key pool,
 * env bindings) stays in code, so a route naming a provider this API cannot
 * execute is skipped rather than guessed.
 */
export function getCatalogBuiltInModelRouteCandidates(
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing?: BuiltInRoutePricing,
): readonly BuiltInModelRouteTarget[] {
  if (selectedModel === AUTO_RUN_MODEL) {
    const pricingRoute = catalogBuiltInCandidates(catalog, AUTO_RUN_MODEL).find((route) => route.concreteProviderType === AUTO_RUN_PROVIDER);
    if (routePricing && (!pricingRoute || !isBuiltInRoutePriced(routePricing, pricingRoute))) { return []; }
    return [{ selectedModel: AUTO_RUN_MODEL, providerType: AUTO_RUN_PROVIDER, upstreamModel: AUTO_RUN_UPSTREAM_MODEL, vendor: BUILT_IN_MODEL_ROUTE_PROVIDERS[AUTO_RUN_PROVIDER].vendor }];
  }
  return catalogBuiltInCandidates(catalog, selectedModel).flatMap((route) => {
    const providerType = route.concreteProviderType;
    if (!isBuiltInModelRouteProviderType(providerType)) {
      return [];
    }
    // A new run must not execute on a route whose billable categories lack
    // usage_pricing; like any unavailable candidate, it yields to the next.
    if (routePricing && !isBuiltInRoutePriced(routePricing, route)) {
      return [];
    }
    return [
      {
        selectedModel,
        providerType,
        upstreamModel: route.upstreamModel,
        vendor: BUILT_IN_MODEL_ROUTE_PROVIDERS[providerType].vendor,
      },
    ];
  });
}

/**
 * The rejection for a new Built-in run whose model has executable catalog
 * candidates but none with complete usage pricing, naming each route's
 * unpriced categories. Null when some candidate is priced (no route is then
 * available for another reason, such as a missing key or a cooldown) or the
 * model has no executable candidate at all.
 */
export function unpricedBuiltInModelMessage(
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing: BuiltInRoutePricing,
): string | null {
  const routes = catalogBuiltInCandidates(catalog, selectedModel).filter(
    (route) => {
      return isBuiltInModelRouteProviderType(route.concreteProviderType);
    },
  );
  const unpriced = routes.map((route) => {
    return {
      concreteProviderType: route.concreteProviderType,
      categories: unpricedBuiltInRouteCategories(routePricing, route),
    };
  });
  if (
    unpriced.length === 0 ||
    unpriced.some((route) => {
      return route.categories.length === 0;
    })
  ) {
    return null;
  }
  return builtInRoutePricingRejectionMessage(selectedModel, unpriced);
}

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: BuiltInModelRouteProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

function routeFromTarget(
  target: BuiltInModelRouteTarget,
  key: { readonly id: string },
): BuiltInModelRuntimeRoute {
  return {
    selectedModel: target.selectedModel,
    providerType: target.providerType,
    upstreamModel: target.upstreamModel,
    modelKeyId: key.id,
  };
}

function eligibleBuiltInModelRouteCandidates(
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing: BuiltInRoutePricing | undefined,
): readonly BuiltInModelRouteTarget[] {
  return getCatalogBuiltInModelRouteCandidates(
    catalog,
    selectedModel,
    routePricing,
  ).filter((candidate) => {
    return candidate.providerType !== "deepseek";
  });
}

/** Captured routes remain valid independently of the new-selection policy. */
export function isBuiltInModelRuntimeRoutePermitted(
  catalog: ModelCatalog,
  route: BuiltInModelRuntimeRoute,
): boolean {
  return getCatalogBuiltInModelRouteCandidates(
    catalog,
    route.selectedModel,
  ).some((candidate) => {
    return (
      candidate.providerType === route.providerType &&
      candidate.upstreamModel === route.upstreamModel
    );
  });
}

/** Operator-managed key id for each vendor; the vendor column is unique. */
export type BuiltInModelKeyIdsByVendor = ReadonlyMap<string, string>;

async function loadBuiltInModelKeyIdsByVendor(
  db: ReadonlyDb,
): Promise<BuiltInModelKeyIdsByVendor> {
  const rows = await db
    .select({ id: builtInModelKeys.id, vendor: builtInModelKeys.vendor })
    .from(builtInModelKeys);
  return new Map(
    rows.map((row) => {
      return [row.vendor, row.id];
    }),
  );
}

/** Request-scoped, so resolving many policies reads the key table once. */
export const builtInModelKeyIdsByVendor$: Computed<
  Promise<BuiltInModelKeyIdsByVendor>
> = computed(async (get) => {
  return await loadBuiltInModelKeyIdsByVendor(get(db$));
});

/** Loads the catalog once; callers that already hold it use the variant below. */
export async function resolveBuiltInModelRuntimeRoute(
  catalogSnapshot: ModelCatalog,
  db: ReadonlyDb,
  selectedModel: string,
): Promise<BuiltInModelRuntimeRoute | null> {
  const [catalog, keyIdsByVendor] = await Promise.all([
    catalogSnapshot,
    loadBuiltInModelKeyIdsByVendor(db),
  ]);
  return await resolveBuiltInModelRuntimeRouteWithKeys(
    db,
    catalog,
    selectedModel,
    keyIdsByVendor,
  );
}

/**
 * For callers that already hold the request- or run-scoped catalog. A new run
 * passes its route pricing so unpriced candidates are skipped.
 */
export async function resolveBuiltInModelRuntimeRouteFromCatalog(
  db: ReadonlyDb,
  catalog: ModelCatalog,
  selectedModel: string,
  routePricing?: BuiltInRoutePricing,
): Promise<BuiltInModelRuntimeRoute | null> {
  return await firstAvailableBuiltInModelRoute(
    db,
    selectedModel,
    eligibleBuiltInModelRouteCandidates(catalog, selectedModel, routePricing),
    await loadBuiltInModelKeyIdsByVendor(db),
  );
}

export async function resolveBuiltInModelRuntimeRouteWithKeys(
  db: ReadonlyDb,
  catalog: ModelCatalog,
  selectedModel: string,
  keyIdsByVendor: BuiltInModelKeyIdsByVendor,
): Promise<BuiltInModelRuntimeRoute | null> {
  return await firstAvailableBuiltInModelRoute(
    db,
    selectedModel,
    eligibleBuiltInModelRouteCandidates(catalog, selectedModel, undefined),
    keyIdsByVendor,
  );
}

async function firstAvailableBuiltInModelRoute(
  db: ReadonlyDb,
  selectedModel: string,
  eligible: readonly BuiltInModelRouteTarget[],
  keyIdsByVendor: BuiltInModelKeyIdsByVendor,
): Promise<BuiltInModelRuntimeRoute | null> {
  const candidates = eligible.filter((target) => {
    return keyIdsByVendor.has(target.vendor);
  });
  if (candidates.length === 0) {
    return null;
  }
  // One read covers every candidate's cooldown, keeping the hot path bounded.
  const cooling = await db
    .select({
      provider: builtInModelCandidateCooldown.modelRuntimeProvider,
      model: builtInModelCandidateCooldown.modelRuntimeModel,
    })
    .from(builtInModelCandidateCooldown)
    .where(
      and(
        eq(builtInModelCandidateCooldown.selectedModel, selectedModel),
        inArray(
          builtInModelCandidateCooldown.modelRuntimeProvider,
          candidates.map((target) => {
            return target.providerType;
          }),
        ),
        gt(builtInModelCandidateCooldown.unavailableUntil, nowDate()),
      ),
    );
  for (const target of candidates) {
    const cooled = cooling.some((row) => {
      return (
        row.provider === target.providerType &&
        row.model === target.upstreamModel
      );
    });
    const keyId = keyIdsByVendor.get(target.vendor);
    if (!cooled && keyId !== undefined) {
      return routeFromTarget(target, { id: keyId });
    }
  }
  return null;
}

/** Choose the same first eligible route from one batched cooldown snapshot. */
export function builtInModelRuntimeRouteFromSnapshot(args: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly keyIdsByVendor: BuiltInModelKeyIdsByVendor;
  readonly cooldowns: readonly {
    readonly modelRuntimeProvider: string;
    readonly modelRuntimeModel: string;
  }[];
  /** A new run's route pricing; unpriced candidates are skipped. */
  readonly routePricing?: BuiltInRoutePricing;
}): BuiltInModelRuntimeRoute | null {
  for (const target of eligibleBuiltInModelRouteCandidates(
    args.catalog,
    args.selectedModel,
    args.routePricing,
  )) {
    const id = args.keyIdsByVendor.get(target.vendor);
    if (
      id === undefined ||
      args.cooldowns.some((cooldown) => {
        return (
          cooldown.modelRuntimeProvider === target.providerType &&
          cooldown.modelRuntimeModel === target.upstreamModel
        );
      })
    ) {
      continue;
    }
    return routeFromTarget(target, { id });
  }
  return null;
}
