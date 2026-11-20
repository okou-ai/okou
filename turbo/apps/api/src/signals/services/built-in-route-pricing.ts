import {
  AUTO_SELECTED_MODEL,
  autoRunBillingProvider,
} from "@okouai/core/auto-run-model";
import {
  type CatalogRoute,
  type ModelCatalog,
  catalogBuiltInRoute,
} from "./model-catalog.service";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-provider-types";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ResolvedModelProviderEnvironment,
  PermissionManifest,
} from "./agent-run-contracts";

/** The provider-wide row settlement uses when a category has no exact row. */
const USAGE_PRICING_FALLBACK_CATEGORY = "__fallback__";

const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

/** The run's requested Codex service tier (`agent_runs.codex_service_tier`). */
type RunServiceTier = CodexServiceTier | null | undefined;

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
 * for the Runner), and the requested service tier's `.fast` suffix
 * variants. Standard-tier categories stay included for a tiered run
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
  readonly serviceTier: RunServiceTier;
}

export function builtInRoutePricingFromSnapshot(
  args: {
    readonly serviceTier: RunServiceTier;
  },
  byKey: ReadonlyMap<string, unknown>,
): BuiltInRoutePricing {
  return { byKey, serviceTier: args.serviceTier };
}

/**
 * The one user-facing rejection for a Built-in run that cannot be billed,
 * naming the usage categories its route would report unpriced.
 */
export function builtInRoutePricingRejectionMessage(
  model: string,
  categories: readonly string[],
): string {
  return `Built-in model ${model} has no complete usage pricing: ${categories.join(", ")}`;
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
  return categories.filter((category) => {
    return (
      findUsagePricing(
        pricing.byKey,
        pricingKind,
        pricingProvider,
        category,
      ) === undefined
    );
  });
}

export function billableFirewallsForPermissions(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissions:
    Pick<PermissionManifest, "firewalls" | "billableFirewalls"> | undefined;
}): string[] {
  const firewalls = args.permissions?.firewalls ?? [];
  const firewallNames = firewalls.map((firewall) => {
    return firewall.kind === "builtin" ? firewall.name : firewall.firewall.name;
  });
  const modelFirewalls = isBuiltInModelProviderType(args.modelProvider?.type)
    ? firewallNames.filter(isModelProviderFirewallName)
    : [];
  const connectorFirewalls = args.permissions?.billableFirewalls ?? [];

  return [...modelFirewalls, ...connectorFirewalls];
}

function isModelProviderFirewallName(name: string): boolean {
  return name.startsWith("model-provider:");
}

/**
 * Check that this run's captured Built-in route can report billable usage
 * and that settlement can price every category it may report. Route selection
 * skips unpriced candidates, and this check also covers routes captured earlier.
 */
export function validateModelUsage(args: {
  readonly catalog: ModelCatalog;
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly permissionManifest:
    Pick<PermissionManifest, "firewalls" | "billableFirewalls"> | undefined;
  /**
   * The run's Built-in route pricing, read from the same catalog snapshot;
   * required for a Built-in run (null for every other run).
   */
  readonly routePricing: BuiltInRoutePricing | null;
}): string | null {
  if (!isBuiltInModelProviderType(args.modelProvider.type)) {
    return null;
  }
  const billableFirewalls = billableFirewallsForPermissions({
    modelProvider: args.modelProvider,
    permissions: args.permissionManifest,
  });
  const route = builtInRouteForContext(args.catalog, args.modelProvider);
  if (!billableFirewalls.some(isModelProviderFirewallName)) {
    return null;
  }
  if (!route?.pricingProvider) {
    return "Built-in model provider did not resolve a supported model for usage reporting";
  }
  if (!args.routePricing) {
    throw new Error("A Built-in run requires its route pricing snapshot");
  }
  const unpriced = unpricedBuiltInRouteCategories(args.routePricing, route);
  if (unpriced.length === 0) {
    return null;
  }
  return builtInRoutePricingRejectionMessage(route.model, unpriced);
}

/**
 * The pricing snapshot of a Built-in run's model candidates (one read), or
 * null for every other run.
 */
export function runRoutePricingFromSnapshot(
  args: {
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly serviceTier: CodexServiceTier | undefined;
  },
  byKey: ReadonlyMap<string, unknown>,
): BuiltInRoutePricing | null {
  return args.modelProvider?.selectedModel &&
    isBuiltInModelProviderType(args.modelProvider.type)
    ? builtInRoutePricingFromSnapshot(args, byKey)
    : null;
}

/**
 * The catalog Built-in route a Built-in run was assigned. Its pricing link is
 * the provider the Runner addon reports model usage events under, which
 * settlement uses as the `usage_pricing` provider; it is read from the same
 * catalog snapshot as the route itself, and the selected model stays the
 * run's model.
 */
function builtInRouteForContext(
  catalog: ModelCatalog,
  modelProvider: ResolvedModelProviderEnvironment,
): CatalogRoute | null {
  if (!modelProvider.selectedModel) {
    return null;
  }
  const runtime = modelProvider.builtInModelRuntimeRoute;
  if (modelProvider.selectedModel === AUTO_SELECTED_MODEL && !runtime) {
    throw new Error(
      "Canonical Auto billing requires its captured runtime route",
    );
  }
  const concreteProviderType =
    runtime?.providerType ?? modelProvider.concreteType;
  if (!concreteProviderType) {
    return null;
  }
  const route = catalogBuiltInRoute(
    catalog,
    modelProvider.selectedModel,
    concreteProviderType,
  );
  // Captured runtime owns billing even if the organization's current preset changed.
  return route && runtime && modelProvider.selectedModel === AUTO_SELECTED_MODEL
    ? {
        ...route,
        upstreamModel: runtime.upstreamModel,
        pricingProvider: autoRunBillingProvider(
          modelProvider.selectedModel,
          runtime.upstreamModel,
        ),
      }
    : route;
}
