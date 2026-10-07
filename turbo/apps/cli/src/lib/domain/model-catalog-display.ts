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

/** The CLI argument for Auto, which the API represents as a null selection. */
const AUTO_MODEL_ARGUMENT = "auto";
export const AUTO_MODEL_LABEL = "Auto";

/** `auto` selects Auto (null); any other id is passed through as given. */
export function parseModelSelectionArgument(value: string): string | null {
  return value.trim().toLowerCase() === AUTO_MODEL_ARGUMENT ? null : value;
}

/** The argument that selects a model: its id, or `auto` for Auto. */
export function formatModelSelectionArgument(model: string | null): string {
  return model ?? AUTO_MODEL_ARGUMENT;
}

/**
 * The model a selection actually runs: Auto runs the catalog system default,
 * and a retired model resolves along its replacement chain. Unknown ids are
 * shown as stored so the server remains the one to reject them.
 */
export function resolveCatalogModel(
  catalog: ModelCatalogResponse,
  model: string | null,
): string {
  if (model === null) {
    return catalog.systemDefaultModel;
  }
  return findCatalogModel(catalog, model)?.resolvedModel ?? model;
}

/** `Auto`, or `Display Name (model-id)` for any other selection. */
export function formatCatalogModelSelection(
  catalog: ModelCatalogResponse,
  model: string | null,
): string {
  if (model === null) {
    return AUTO_MODEL_LABEL;
  }
  return `${getCatalogModelDisplayName(catalog, model)} (${model})`;
}

export function getCatalogModelDisplayName(
  catalog: ModelCatalogResponse,
  model: string,
): string {
  return findCatalogModel(catalog, model)?.displayName ?? model;
}

/** Retired models stay readable for history but are never offered. */
export function isCatalogModelActive(
  catalog: ModelCatalogResponse,
  model: string | null,
): boolean {
  if (model === null) {
    return true;
  }
  const entry = findCatalogModel(catalog, model);
  return entry !== undefined && entry.replacedBy === null;
}

/**
 * Order model-keyed items by catalog sort order; Auto goes first and unknown
 * models go last.
 */
export function sortByCatalogOrder<T extends { readonly model: string | null }>(
  catalog: ModelCatalogResponse,
  items: readonly T[],
): T[] {
  const order = new Map(
    catalog.models.map((entry) => {
      return [entry.model, entry.sortOrder] as const;
    }),
  );
  const rank = (model: string | null): number => {
    if (model === null) {
      return Number.MIN_SAFE_INTEGER;
    }
    return order.get(model) ?? Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((left, right) => {
    return rank(left.model) - rank(right.model);
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

/**
 * `Auto`, or `Display Name (model-id)` for the model a stored selection runs,
 * followed by its effective effort.
 */
export function formatCatalogThreadModel(
  catalog: ModelCatalogResponse,
  storedModel: string | null,
  settings?: ThreadModelSettings | null,
): string {
  const model = resolveCatalogModel(catalog, storedModel);
  const effort = getCatalogThreadEffort(catalog, model, settings);
  const suffix = effort ? ` · effort ${effort}` : "";
  const selection = storedModel === null ? null : model;
  return `${formatCatalogModelSelection(catalog, selection)}${suffix}`;
}
