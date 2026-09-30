import { asc, sql } from "drizzle-orm";
import {
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import type { ReadonlyDb } from "../external/db";

type CatalogModel = Readonly<{
  model: string;
  displayName: string;
  sortOrder: number;
  isSystemDefault: boolean;
  replacedBy: string | null;
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
}>;

export type ModelCatalog = Readonly<{
  models: readonly CatalogModel[];
  routes: readonly CatalogRoute[];
  systemDefault: CatalogModel;
  /**
   * The system default narrowed to a model whose protocol adapter this API
   * knows. Runtime execution (framework, env bindings, context limits) stays
   * in code, so an operator default the code cannot execute is an error.
   */
  systemDefaultModel: SupportedRunModel;
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

function validateModelCatalog(
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
  const defaults = models.filter((row) => {
    return row.isSystemDefault;
  });
  const [systemDefault] = defaults;
  if (!systemDefault || defaults.length !== 1) {
    throw new ModelCatalogInvariantError(
      `expected exactly one system default, found ${defaults.length}`,
    );
  }
  if (systemDefault.replacedBy !== null) {
    throw new ModelCatalogInvariantError(
      `system default ${systemDefault.model} is retired`,
    );
  }
  const hasBuiltInRoute = routes.some((route) => {
    return (
      route.model === systemDefault.model &&
      route.providerType === "built-in" &&
      route.enabled
    );
  });
  if (!hasBuiltInRoute) {
    throw new ModelCatalogInvariantError(
      `system default ${systemDefault.model} has no enabled Built-in route`,
    );
  }
  if (!isSupportedRunModel(systemDefault.model)) {
    throw new ModelCatalogInvariantError(
      `system default ${systemDefault.model} has no runtime adapter`,
    );
  }
  return {
    models,
    routes,
    systemDefault,
    systemDefaultModel: systemDefault.model,
    byModel,
  };
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
 * catalog resolves it to an active model with at least one enabled route.
 * Route-specific checks (the chosen provider type) happen at route selection.
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
    return route.enabled && route.model === resolution.resolvedModel;
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

/** Enabled Built-in candidates of a model in ascending fallback priority. */
export function catalogBuiltInCandidates(
  catalog: ModelCatalog,
  model: string,
): readonly CatalogRoute[] {
  return [...catalogRoutesFor(catalog, model, "built-in")].sort((a, b) => {
    return a.priority - b.priority;
  });
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
 * Loaded per call: operators change the catalog directly in the database, and
 * the two reads are small. Correctness (a changed default is visible to the
 * next request) wins over caching until a measured need appears.
 */
export async function loadModelCatalog(
  db: Pick<ReadonlyDb, "select">,
): Promise<ModelCatalog> {
  const [models, routes] = await Promise.all([
    db
      .select({
        model: runModelCatalog.model,
        displayName: runModelCatalog.displayName,
        sortOrder: runModelCatalog.sortOrder,
        isSystemDefault: runModelCatalog.isSystemDefault,
        replacedBy: runModelCatalog.replacedBy,
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
}

/** The DB-owned system default every organization uses. */
export async function loadSystemDefaultRunModel(
  db: ReadonlyDb,
): Promise<SupportedRunModel> {
  return (await loadModelCatalog(db)).systemDefaultModel;
}
