import type { MemberRunModelCatalog } from "@okouai/api-contracts/contracts/member-run-model";
import {
  getBuiltInRouteProviderVendor,
  getFrameworkForType,
  isBuiltInModelProviderType,
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  AUTO_RUN_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  AUTO_RUN_MODEL,
  AUTO_RUN_PRICING_PROVIDER,
  AUTO_RUN_PROVIDER,
  AUTO_RUN_UPSTREAM_MODEL,
} from "@okouai/core/auto-run-model";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { command, computed, type Computed } from "ccstate";
import { asc, sql } from "drizzle-orm";
import { db$ } from "../external/db";

/** `usage_pricing.kind` of model token usage (the addon's `MODEL_USAGE_KIND`). */
const MODEL_USAGE_PRICING_KIND = "model";

type CatalogModel = Readonly<{
  model: string;
  displayName: string;
  sortOrder: number;
  isSystemDefault: boolean;
  replacedBy: string | null;
  /** Restricted (free) plans may run the model on Built-in routes. */
  builtInOnRestrictedPlans: boolean;
  /** Pi route class (`run_model_catalog.pi_route_class`); null = not Pi-eligible. */
  piRouteClass: string | null;
}>;

export type CatalogRoute = Readonly<{
  model: string;
  providerType: string;
  concreteProviderType: string;
  subscriptionType: string | null;
  upstreamModel: string;
  enabled: boolean;
  priority: number;
  serviceTiers: readonly string[];
  defaultServiceTier: string | null;
  efforts: readonly string[];
  defaultEffort: string | null;
  priceTier: string | null;
  /**
   * `usage_pricing` key that bills usage on this route (Built-in only; NULL on
   * BYOK and subscription routes, which are not platform-billed).
   */
  pricingKind: string | null;
  pricingProvider: string | null;
  /**
   * Inclusive total-input boundary at which usage on this Built-in route bills
   * the `.long_context` categories (`long_context_min_total_input_tokens`).
   * NULL: the route bills a single tier. Always NULL off Built-in routes.
   */
  longContextMinTotalInputTokens: number | null;
}>;

function autoCatalogRoute(): CatalogRoute {
  return {
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
    priceTier: null,
    pricingKind: MODEL_USAGE_PRICING_KIND,
    pricingProvider: AUTO_RUN_PRICING_PROVIDER,
    longContextMinTotalInputTokens:
      AUTO_RUN_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  };
}

function autoCatalogModel(): CatalogModel {
  return {
    model: AUTO_RUN_MODEL,
    displayName: "Auto",
    sortOrder: 0,
    isSystemDefault: true,
    replacedBy: null,
    builtInOnRestrictedPlans: true,
    piRouteClass: "gpt-codex",
  };
}

export type ModelCatalog = Readonly<{
  models: readonly CatalogModel[];
  routes: readonly CatalogRoute[];
  systemDefault: CatalogModel;
  /** The system default's model ID; it always has a runnable Built-in route. */
  systemDefaultModel: string;
  byModel: ReadonlyMap<string, CatalogModel>;
}>;

export type CatalogModelResolution =
  | Readonly<{
      kind: "active";
      model: string;
      resolvedModel: string;
      chain: readonly string[];
    }>
  | Readonly<{
      kind: "replaced";
      model: string;
      resolvedModel: string;
      chain: readonly string[];
    }>
  | Readonly<{ kind: "unknown"; model: string }>;

/** A broken catalog is an operator error and must never fall back silently. */
export class ModelCatalogInvariantError extends Error {
  constructor(message: string) {
    super(`Invalid model catalog: ${message}`);
    this.name = "ModelCatalogInvariantError";
  }
}

/**
 * Follow `replaced_by` to the final active model. The schema only admits
 * active direct targets, but lineage chains are allowed; a cycle or dangling
 * target is still re-checked here because silently picking a model is worse
 * than failing the request.
 */
function followReplacementChain(
  byModel: ReadonlyMap<string, CatalogModel>,
  row: CatalogModel,
): readonly string[] {
  const chain = [row.model];
  let current = row;
  while (current.replacedBy !== null) {
    const next = byModel.get(current.replacedBy);
    if (!next) {
      throw new ModelCatalogInvariantError(
        `${current.model} is replaced by missing model ${current.replacedBy}`,
      );
    }
    if (chain.includes(next.model)) {
      throw new ModelCatalogInvariantError(
        `replacement cycle ${[...chain, next.model].join(" -> ")}`,
      );
    }
    chain.push(next.model);
    current = next;
  }
  return chain;
}

export function validateModelCatalog(
  models: readonly CatalogModel[],
  routes: readonly CatalogRoute[],
): ModelCatalog {
  const byModel = new Map(
    models.map((row) => {
      return [row.model, row];
    }),
  );
  for (const row of models) {
    followReplacementChain(byModel, row);
  }
  const systemDefault = autoCatalogModel();
  byModel.set(AUTO_RUN_MODEL, systemDefault);
  for (const route of routes) {
    validateRoutePricingLink(route);
  }
  return {
    models: [
      systemDefault,
      ...models.filter((model) => {
        return model.model !== AUTO_RUN_MODEL;
      }),
    ],
    routes: [
      autoCatalogRoute(),
      ...routes.filter((route) => {
        return route.model !== AUTO_RUN_MODEL;
      }),
    ],
    systemDefault,
    systemDefaultModel: systemDefault.model,
    byModel,
  };
}

/**
 * A Built-in route is billed through its `usage_pricing` link; every other
 * route is not platform-billed and carries none. The schema CHECK states the
 * same rule; it is re-checked here because billing a Built-in run under no or
 * the wrong pricing identity is worse than failing the request.
 */
function validateRoutePricingLink(route: CatalogRoute): void {
  const label = `${route.model} ${route.providerType}/${route.concreteProviderType}`;
  if (isBuiltInModelProviderType(route.providerType)) {
    if (
      route.pricingKind !== MODEL_USAGE_PRICING_KIND ||
      !route.pricingProvider
    ) {
      throw new ModelCatalogInvariantError(
        `Built-in route ${label} has no model pricing link`,
      );
    }
    const threshold = route.longContextMinTotalInputTokens;
    if (
      threshold !== null &&
      (!Number.isSafeInteger(threshold) || threshold <= 0)
    ) {
      throw new ModelCatalogInvariantError(
        `Built-in route ${label} has an invalid long-context threshold`,
      );
    }
    return;
  }
  if (
    route.pricingKind !== null ||
    route.pricingProvider !== null ||
    route.longContextMinTotalInputTokens !== null
  ) {
    throw new ModelCatalogInvariantError(
      `non-Built-in route ${label} must not carry a pricing link`,
    );
  }
}

/**
 * The enabled Built-in route of `model` on the concrete provider a run was
 * assigned, or null when the catalog has no such route. Its pricing link is
 * the `usage_pricing` provider the run's model usage events are reported and
 * billed under.
 */
export function catalogBuiltInRoute(
  catalog: ModelCatalog,
  model: string,
  concreteProviderType: string,
): CatalogRoute | null {
  if (model === AUTO_RUN_MODEL) {
    return concreteProviderType === AUTO_RUN_PROVIDER
      ? autoCatalogRoute()
      : null;
  }
  return (
    catalogRoutesFor(catalog, model, "built-in").find((candidate) => {
      return candidate.concreteProviderType === concreteProviderType;
    }) ?? null
  );
}

/**
 * Whether code can execute an enabled route. Adapters are keyed by provider,
 * never by model ID: a Built-in route needs a concrete provider with a vendor
 * key pool and environment bindings, and any other route needs a provider
 * type this code knows. A model added only as catalog rows on an existing
 * protocol is therefore executable without a code change.
 */
export function isCatalogRouteExecutable(
  route: Pick<
    CatalogRoute,
    "enabled" | "providerType" | "concreteProviderType"
  >,
): boolean {
  if (!route.enabled) {
    return false;
  }
  if (isBuiltInModelProviderType(route.providerType)) {
    return (
      getBuiltInRouteProviderVendor(route.concreteProviderType) !== undefined
    );
  }
  return modelProviderTypeSchema.safeParse(route.providerType).success;
}

/**
 * Resolve a stored selection to its final active model. Unknown models are
 * reported as such; callers decide how to handle them, never by silently
 * substituting the system default.
 */
export function resolveCatalogModel(
  catalog: ModelCatalog,
  model: string,
): CatalogModelResolution {
  const row = catalog.byModel.get(model);
  if (!row) {
    return { kind: "unknown", model };
  }
  const chain = followReplacementChain(catalog.byModel, row);
  const resolvedModel = chain[chain.length - 1] ?? model;
  return {
    kind: row.replacedBy === null ? "active" : "replaced",
    model,
    resolvedModel,
    chain,
  };
}

/**
 * The final active model for a stored selection when it is runnable: the
 * catalog resolves it to an active model with at least one enabled route that
 * has a runtime adapter (`isCatalogRouteExecutable`). Route-specific checks
 * (the chosen provider type) happen at route selection.
 */
export function resolveCatalogRunModel(
  catalog: ModelCatalog,
  model: string,
): string | null {
  const resolution = resolveCatalogModel(catalog, model);
  if (resolution.kind === "unknown") {
    return null;
  }
  return catalog.routes.some((route) => {
    return (
      route.model === resolution.resolvedModel &&
      isCatalogRouteExecutable(route)
    );
  })
    ? resolution.resolvedModel
    : null;
}

/**
 * Whether the catalog runs the model directly: it is active and has an
 * enabled route. A retired or unknown ID must be resolved before admission.
 */
export function isCatalogModelRunnable(
  catalog: ModelCatalog,
  model: string,
): boolean {
  return resolveCatalogRunModel(catalog, model) === model;
}

/** Platform admission is fixed Auto, never a catalog fallback directory. */
export function catalogBuiltInCandidates(
  _catalog: ModelCatalog,
  model: string,
): readonly CatalogRoute[] {
  return model === AUTO_RUN_MODEL ? [autoCatalogRoute()] : [];
}

/**
 * Upstream model ID of the model's enabled route for a selected (non
 * Built-in) provider type, or null when the catalog has no such route.
 */
export function catalogProviderUpstreamModel(
  catalog: ModelCatalog,
  model: string,
  providerType: string,
): string | null {
  const [route] = catalogRoutesFor(catalog, model, providerType);
  return route?.upstreamModel ?? null;
}

/** Only active models (`replaced_by IS NULL`) may be newly configured. */
export function isCatalogModelAddable(
  catalog: ModelCatalog,
  model: string,
): boolean {
  const row = catalog.byModel.get(model);
  return row !== undefined && row.replacedBy === null;
}

/** Enabled routes of one model for a selected provider type. */
export function catalogRoutesFor(
  catalog: ModelCatalog,
  model: string,
  providerType: string,
  subscriptionType: string | null = null,
): readonly CatalogRoute[] {
  return catalog.routes.filter((route) => {
    return (
      route.enabled &&
      route.model === model &&
      route.providerType === providerType &&
      route.subscriptionType === subscriptionType
    );
  });
}

/** Whether a model has any enabled route for a selected provider type. */
export function catalogHasProviderRoute(
  catalog: ModelCatalog,
  model: string,
  providerType: string,
): boolean {
  return catalog.routes.some((route) => {
    return (
      route.enabled &&
      route.model === model &&
      route.providerType === providerType
    );
  });
}

/** The catalog lookups member policy configurability reads. */
export function memberRunModelCatalog(
  catalog: ModelCatalog,
): MemberRunModelCatalog {
  return {
    resolve(model) {
      const resolution = resolveCatalogModel(catalog, model);
      return resolution.kind === "unknown"
        ? undefined
        : resolution.resolvedModel;
    },
    routes(model, query) {
      return catalog.routes.filter((route) => {
        return (
          route.enabled &&
          route.model === model &&
          route.providerType === query.providerType
        );
      });
    },
  };
}

/** Display price tier of the model's primary Built-in route. */
export function catalogBuiltInPriceTier(
  catalog: ModelCatalog,
  model: string,
): string | null {
  const [primary] = catalogRoutesFor(catalog, model, "built-in");
  return primary?.priceTier ?? null;
}

/** The catalog display name; unknown IDs are shown verbatim. */
export function catalogDisplayName(
  catalog: ModelCatalog,
  model: string,
): string {
  return catalog.byModel.get(model)?.displayName ?? model;
}

/** Active models in picker order. */
export function catalogActiveModels(catalog: ModelCatalog): readonly string[] {
  return catalog.models
    .filter((row) => {
      return row.replacedBy === null;
    })
    .map((row) => {
      return row.model;
    });
}

/** Picker rank; models outside the catalog sort last. */
export function catalogModelRank(catalog: ModelCatalog, model: string): number {
  return catalog.byModel.get(model)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Loaded per owning graph: operators change the catalog directly in the database, and
 * the two reads are small. Correctness (a changed default is visible to the
 * next request) wins over caching until a measured need appears.
 */
export function createModelCatalog(): Computed<Promise<ModelCatalog>> {
  return computed(async (get): Promise<ModelCatalog> => {
    const db = get(db$);
    const [models, routes] = await Promise.all([
      db
        .select({
          model: runModelCatalog.model,
          displayName: runModelCatalog.displayName,
          sortOrder: runModelCatalog.sortOrder,
          isSystemDefault: runModelCatalog.isSystemDefault,
          replacedBy: runModelCatalog.replacedBy,
          builtInOnRestrictedPlans: runModelCatalog.builtInOnRestrictedPlans,
          piRouteClass: runModelCatalog.piRouteClass,
        })
        .from(runModelCatalog)
        .orderBy(asc(runModelCatalog.sortOrder), asc(runModelCatalog.model)),
      db
        .select({
          model: modelRoutes.model,
          providerType: modelRoutes.providerType,
          concreteProviderType: modelRoutes.concreteProviderType,
          subscriptionType: modelRoutes.subscriptionType,
          upstreamModel: modelRoutes.upstreamModel,
          enabled: modelRoutes.enabled,
          priority: modelRoutes.priority,
          serviceTiers: modelRoutes.serviceTiers,
          defaultServiceTier: modelRoutes.defaultServiceTier,
          efforts: modelRoutes.efforts,
          defaultEffort: modelRoutes.defaultEffort,
          priceTier: modelRoutes.priceTier,
          pricingKind: modelRoutes.pricingKind,
          pricingProvider: modelRoutes.pricingProvider,
          longContextMinTotalInputTokens:
            modelRoutes.longContextMinTotalInputTokens,
        })
        .from(modelRoutes)
        .orderBy(
          asc(modelRoutes.model),
          asc(modelRoutes.providerType),
          sql`${modelRoutes.subscriptionType} asc nulls first`,
          asc(modelRoutes.priority),
        ),
    ]);
    return validateModelCatalog(models, routes);
  });
}

export const modelCatalog$ = createModelCatalog();

/** Fresh reads for long-lived worker stores; capture and pass the returned snapshot. */
export const loadModelCatalog$ = command(
  async ({ get }, signal?: AbortSignal): Promise<ModelCatalog> => {
    const db = get(db$);
    const [models, routes] = await Promise.all([
      db
        .select({
          model: runModelCatalog.model,
          displayName: runModelCatalog.displayName,
          sortOrder: runModelCatalog.sortOrder,
          isSystemDefault: runModelCatalog.isSystemDefault,
          replacedBy: runModelCatalog.replacedBy,
          builtInOnRestrictedPlans: runModelCatalog.builtInOnRestrictedPlans,
          piRouteClass: runModelCatalog.piRouteClass,
        })
        .from(runModelCatalog)
        .orderBy(asc(runModelCatalog.sortOrder), asc(runModelCatalog.model)),
      db
        .select({
          model: modelRoutes.model,
          providerType: modelRoutes.providerType,
          concreteProviderType: modelRoutes.concreteProviderType,
          subscriptionType: modelRoutes.subscriptionType,
          upstreamModel: modelRoutes.upstreamModel,
          enabled: modelRoutes.enabled,
          priority: modelRoutes.priority,
          serviceTiers: modelRoutes.serviceTiers,
          defaultServiceTier: modelRoutes.defaultServiceTier,
          efforts: modelRoutes.efforts,
          defaultEffort: modelRoutes.defaultEffort,
          priceTier: modelRoutes.priceTier,
          pricingKind: modelRoutes.pricingKind,
          pricingProvider: modelRoutes.pricingProvider,
          longContextMinTotalInputTokens:
            modelRoutes.longContextMinTotalInputTokens,
        })
        .from(modelRoutes)
        .orderBy(
          asc(modelRoutes.model),
          asc(modelRoutes.providerType),
          sql`${modelRoutes.subscriptionType} asc nulls first`,
          asc(modelRoutes.priority),
        ),
    ]);
    signal?.throwIfAborted();
    return validateModelCatalog(models, routes);
  },
);

/** The DB-owned system default, derived from the same request catalog. */
export const systemDefaultRunModel$ = computed(async (get): Promise<string> => {
  return (await get(modelCatalog$)).systemDefaultModel;
});

export function frameworkForProviderSelection(
  catalog: ModelCatalog,
  providerType: ModelProviderType,
  selectedModel: string | null | undefined,
): SupportedFramework | null {
  if (!isBuiltInModelProviderType(providerType)) {
    return getFrameworkForType(providerType);
  }
  // The Built-in framework follows the primary catalog candidate's concrete
  // provider protocol.
  const [primary] = catalogBuiltInCandidates(
    catalog,
    selectedModel ?? catalog.systemDefaultModel,
  );
  const concrete = primary?.concreteProviderType;
  return concrete !== undefined && isModelProviderType(concrete)
    ? getFrameworkForType(concrete)
    : null;
}

function isModelProviderType(type: string): type is ModelProviderType {
  return Object.hasOwn(MODEL_PROVIDER_TYPES, type);
}
