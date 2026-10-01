import type { ModelCatalogResponse } from "@okouai/api-contracts/contracts/model-catalog";

type CatalogModel = ModelCatalogResponse["models"][number];
type CatalogRoute = ModelCatalogResponse["routes"][number];

/** Per-model saved preferences keyed by plain catalog model id. */
type ThreadModelSettings = Readonly<
  Record<string, { readonly effort?: string } | undefined>
>;

function findCatalogModel(
  catalog: ModelCatalogResponse,
  model: string,
): CatalogModel | undefined {
  return catalog.models.find((candidate) => {
    return candidate.model === model;
  });
}

/**
 * The model a stored selection actually runs: no selection means the catalog
 * system default, and a retired model resolves along its replacement chain.
 * Unknown ids are shown as stored so the server remains the one to reject them.
 */
export function resolveCatalogModel(
  catalog: ModelCatalogResponse,
  model: string | null | undefined,
): string {
  if (!model) {
    return catalog.systemDefaultModel;
  }
  return findCatalogModel(catalog, model)?.resolvedModel ?? model;
}

export function getCatalogModelDisplayName(
  catalog: ModelCatalogResponse,
  model: string,
): string {
  return findCatalogModel(catalog, model)?.displayName ?? model;
}

export function isCatalogSystemDefaultModel(
  catalog: ModelCatalogResponse,
  model: string,
): boolean {
  return model === catalog.systemDefaultModel;
}

/** Retired models stay readable for history but are never offered. */
export function isCatalogModelActive(
  catalog: ModelCatalogResponse,
  model: string,
): boolean {
  const entry = findCatalogModel(catalog, model);
  return entry !== undefined && entry.replacedBy === null;
}

export function getCatalogModelPriceTier(
  catalog: ModelCatalogResponse,
  model: string,
): string | null {
  return findCatalogModel(catalog, model)?.priceTier ?? null;
}

/** Order model-keyed items by catalog sort order; unknown models go last. */
export function sortByCatalogOrder<T extends { readonly model: string }>(
  catalog: ModelCatalogResponse,
  items: readonly T[],
): T[] {
  const order = new Map(
    catalog.models.map((entry) => {
      return [entry.model, entry.sortOrder] as const;
    }),
  );
  return [...items].sort((left, right) => {
    return (
      (order.get(left.model) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.model) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function enabledRoutes(
  catalog: ModelCatalogResponse,
  model: string,
): CatalogRoute[] {
  return catalog.routes
    .filter((route) => {
      return route.model === model && route.enabled;
    })
    .sort((left, right) => {
      return left.priority - right.priority;
    });
}

/** Efforts any enabled route of the model accepts, in route order. */
export function getCatalogModelEfforts(
  catalog: ModelCatalogResponse,
  model: string,
): string[] {
  const efforts: string[] = [];
  for (const route of enabledRoutes(catalog, model)) {
    for (const effort of route.efforts) {
      if (!efforts.includes(effort)) {
        efforts.push(effort);
      }
    }
  }
  return efforts;
}

function getCatalogModelDefaultEffort(
  catalog: ModelCatalogResponse,
  model: string,
): string | null {
  const routes = enabledRoutes(catalog, model);
  const builtIn = routes.find((route) => {
    return route.providerType === "built-in";
  });
  return (builtIn ?? routes[0])?.defaultEffort ?? null;
}

/**
 * The effort a thread runs with: its saved override for the effective model,
 * otherwise the catalog default. Settings saved under a retired id are not
 * transplanted onto the replacement.
 */
export function getCatalogThreadEffort(
  catalog: ModelCatalogResponse,
  model: string,
  settings: ThreadModelSettings | null | undefined,
): string | null {
  const saved = settings?.[model]?.effort;
  if (
    saved !== undefined &&
    getCatalogModelEfforts(catalog, model).includes(saved)
  ) {
    return saved;
  }
  return getCatalogModelDefaultEffort(catalog, model);
}

/** `Display Name (model-id)` for the model a stored selection runs. */
export function formatCatalogThreadModel(
  catalog: ModelCatalogResponse,
  storedModel: string | null | undefined,
  settings?: ThreadModelSettings | null,
): string {
  const model = resolveCatalogModel(catalog, storedModel);
  const effort = getCatalogThreadEffort(catalog, model, settings);
  const suffix = effort ? ` · effort ${effort}` : "";
  return `${getCatalogModelDisplayName(catalog, model)} (${model})${suffix}`;
}
