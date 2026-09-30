import { asc, sql } from "drizzle-orm";
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

type CatalogRoute = Readonly<{
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

type ModelCatalog = Readonly<{
  models: readonly CatalogModel[];
  routes: readonly CatalogRoute[];
  systemDefault: CatalogModel;
}>;

type CatalogModelResolution =
  | Readonly<{ kind: "active"; model: string }>
  | Readonly<{ kind: "replaced"; model: string; resolvedModel: string }>
  | Readonly<{ kind: "unknown"; model: string }>;

/** A broken catalog is an operator error and must never fall back silently. */
class ModelCatalogInvariantError extends Error {
  constructor(message: string) {
    super(`Invalid model catalog: ${message}`);
    this.name = "ModelCatalogInvariantError";
  }
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
    if (row.replacedBy === null) {
      continue;
    }
    const target = byModel.get(row.replacedBy);
    if (!target || target.replacedBy !== null) {
      throw new ModelCatalogInvariantError(
        `${row.model} is replaced by ${row.replacedBy}, which is not an active model`,
      );
    }
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
  return { models, routes, systemDefault };
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
  const row = catalog.models.find((candidate) => {
    return candidate.model === model;
  });
  if (!row) {
    return { kind: "unknown", model };
  }
  if (row.replacedBy === null) {
    return { kind: "active", model };
  }
  // Constraints keep replacement chains to one hop; validation re-checks it.
  return { kind: "replaced", model, resolvedModel: row.replacedBy };
}

export async function loadModelCatalog(db: ReadonlyDb): Promise<ModelCatalog> {
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
