import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, inArray } from "drizzle-orm";

import {
  resolveUsagePricingProvider,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { computed } from "ccstate";
import { db$ } from "../external/db";
import {
  catalogBuiltInCandidates,
  type CatalogRoute,
  type ModelCatalog,
} from "./model-catalog.service";

/** The provider-wide row settlement uses when a category has no exact row. */
const USAGE_PRICING_FALLBACK_CATEGORY = "__fallback__";

const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

/** The run's requested Codex service tier (`agent_runs.codex_service_tier`). */
type RunServiceTier = "fast" | "ultrafast" | null | undefined;

function usagePricingKey(
  kind: string,
  provider: string,
  category: string,
): string {
  return `${kind}|${provider}|${category}`;
}

/**
 * Settlement's `usage_pricing` lookup: the exact `(kind, provider, category)`
 * row, else the provider's `__fallback__` row. Admission preflight uses the
 * same lookup, so a route admitted as priced is priced at settlement.
 */
export function findUsagePricing<T>(
  byKey: ReadonlyMap<string, T>,
  kind: string,
  lookupProvider: string,
  category: string,
): { readonly pricing: T; readonly exact: boolean } | undefined {
  const exact = byKey.get(usagePricingKey(kind, lookupProvider, category));
  if (exact !== undefined) {
    return { pricing: exact, exact: true };
  }
  const fallback = byKey.get(
    usagePricingKey(kind, lookupProvider, USAGE_PRICING_FALLBACK_CATEGORY),
  );
  return fallback === undefined
    ? undefined
    : { pricing: fallback, exact: false };
}

/** Index pricing rows by settlement's lookup key. */
export function usagePricingByKey<
  T extends { readonly kind: string; readonly provider: string },
>(rows: readonly (T & { readonly category: string })[]): Map<string, T> {
  return new Map(
    rows.map((row) => {
      return [usagePricingKey(row.kind, row.provider, row.category), row];
    }),
  );
}

/**
 * Every usage category a Built-in run on this route can report (the Runner
 * addon's category scheme): the four token categories, their `.long_context`
 * variants when the route has a long-context threshold (the route's own
 * `long_context_min_total_input_tokens`, exactly the value the API captures
 * for the Runner), and the requested service tier's `.fast` / `.ultrafast`
 * suffix variants. Standard-tier categories stay included for a tiered run
 * because the provider may serve a request at the standard tier.
 */
function builtInRouteBillableCategories(
  route: Pick<CatalogRoute, "longContextMinTotalInputTokens">,
  serviceTier: RunServiceTier,
): readonly string[] {
  const base: string[] = [...MODEL_TOKEN_CATEGORIES];
  const longContextThreshold = route.longContextMinTotalInputTokens;
  if (longContextThreshold !== null) {
    base.push(
      ...MODEL_TOKEN_CATEGORIES.map((category) => {
        return `${category}.long_context`;
      }),
    );
  }
  if (!serviceTier) {
    return base;
  }
  return [
    ...base,
    ...base.map((category) => {
      return `${category}.${serviceTier}`;
    }),
  ];
}

/**
 * The `usage_pricing` rows that can price a model's Built-in candidates, read
 * once per run for their pricing providers.
 */
export interface BuiltInRoutePricing {
  readonly byKey: ReadonlyMap<string, unknown>;
  readonly resolution: UsagePricingResolution;
  readonly serviceTier: RunServiceTier;
}

interface BuiltInRoutePricingInput {
  readonly catalog: ModelCatalog;
  readonly model: string;
  readonly serviceTier: RunServiceTier;
  readonly resolution: UsagePricingResolution;
}

export function builtInRoutePricing(args: BuiltInRoutePricingInput) {
  return computed(async (get): Promise<BuiltInRoutePricing> => {
    const db = get(db$);
    const links = catalogBuiltInCandidates(args.catalog, args.model).flatMap(
      (route) => {
        return route.pricingKind && route.pricingProvider
          ? [
              {
                kind: route.pricingKind,
                provider: resolveUsagePricingProvider(
                  args.resolution,
                  route.pricingKind,
                  route.pricingProvider,
                ),
              },
            ]
          : [];
      },
    );
    const kinds = [
      ...new Set(
        links.map((link) => {
          return link.kind;
        }),
      ),
    ];
    const providers = [
      ...new Set(
        links.map((link) => {
          return link.provider;
        }),
      ),
    ];
    const rows =
      providers.length === 0
        ? []
        : await db
            .select({
              kind: usagePricing.kind,
              provider: usagePricing.provider,
              category: usagePricing.category,
            })
            .from(usagePricing)
            .where(
              and(
                inArray(usagePricing.kind, kinds),
                inArray(usagePricing.provider, providers),
              ),
            );
    return {
      byKey: usagePricingByKey(rows),
      resolution: args.resolution,
      serviceTier: args.serviceTier,
    };
  });
}

/**
 * The one user-facing rejection for a Built-in run that cannot be billed:
 * each listed route with the usage categories it would report unpriced.
 */
export function builtInRoutePricingRejectionMessage(
  model: string,
  routes: readonly {
    readonly concreteProviderType: string;
    readonly categories: readonly string[];
  }[],
): string {
  const detail = routes
    .map((route) => {
      return `${route.concreteProviderType} (${route.categories.join(", ")})`;
    })
    .join("; ");
  return `Built-in model ${model} has no route with complete usage pricing: ${detail}`;
}

/** Categories the route can produce that settlement could not price. */
export function unpricedBuiltInRouteCategories(
  pricing: BuiltInRoutePricing,
  route: Pick<
    CatalogRoute,
    "pricingKind" | "pricingProvider" | "longContextMinTotalInputTokens"
  >,
): readonly string[] {
  const categories = builtInRouteBillableCategories(route, pricing.serviceTier);
  const { pricingKind, pricingProvider } = route;
  if (!pricingKind || !pricingProvider) {
    return categories;
  }
  const lookupProvider = resolveUsagePricingProvider(
    pricing.resolution,
    pricingKind,
    pricingProvider,
  );
  return categories.filter((category) => {
    return (
      findUsagePricing(pricing.byKey, pricingKind, lookupProvider, category) ===
      undefined
    );
  });
}

export function isBuiltInRoutePriced(
  pricing: BuiltInRoutePricing,
  route: Pick<
    CatalogRoute,
    "pricingKind" | "pricingProvider" | "longContextMinTotalInputTokens"
  >,
): boolean {
  return unpricedBuiltInRouteCategories(pricing, route).length === 0;
}
