import {
  AUTO_SELECTED_MODEL,
  isAutoRunPreset,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { command, computed, state } from "ccstate";
import { modelCatalogContract } from "@okouai/api-contracts/client/model-catalog";
import type { ModelCatalogResponse } from "@okouai/api-contracts/contracts/model-catalog";
import { piCatalogModel, type PiCatalogModel } from "@okouai/core/pi-execution";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";

type CatalogModelEntry = ModelCatalogResponse["models"][number];
type CatalogRouteEntry = ModelCatalogResponse["routes"][number];

export interface ModelCatalogRouteQuery {
  /** The route type (`built-in` Auto or a personal subscription). */
  readonly providerType?: string | null;
  /** The provider serving the request; narrows Built-in candidates. */
  readonly concreteProviderType?: string | null;
}

/**
 * Read-only projection of `GET /api/model-catalog`. The server catalog is the
 * only product authority for model names, ordering, price tiers, retirement
 * and per-route capabilities; this view only indexes it.
 */
export interface ModelCatalog {
  /** Every catalog model, active and retired, in `sortOrder`. */
  readonly models: readonly CatalogModelEntry[];
  /** Models that can be offered or added (`replacedBy === null`), in order. */
  readonly activeModels: readonly CatalogModelEntry[];
  has(model: string | null | undefined): boolean;
  isActive(model: string | null | undefined): boolean;
  /** The catalog display name, or the raw model ID when it is unknown. */
  displayName(model: string): string;
  /**
   * The catalog model a recorded identifier names: the model ID itself, or
   * the one model whose route sends it upstream (for example
   * `openai/gpt-6-luna`). Retired models count, so history keeps its own
   * model; Auto aliases and runtime presets normalize to `auto`.
   * Undefined when unknown or ambiguous.
   */
  modelForIdentifier(identifier: string): string | undefined;
  sortOrder(model: string): number;
  /** Compare two model IDs by catalog order; unknown models sort last. */
  compare(left: string, right: string): number;
  /** The active model a stored selection resolves to; undefined when unknown. */
  resolve(model: string | null | undefined): string | undefined;
  /** Enabled routes of a model, optionally narrowed to one provider route. */
  routes(model: string, query?: ModelCatalogRouteQuery): CatalogRouteEntry[];
  efforts(model: string, query?: ModelCatalogRouteQuery): readonly string[];
  defaultEffort(model: string, query?: ModelCatalogRouteQuery): string | null;
  serviceTiers(
    model: string,
    query?: ModelCatalogRouteQuery,
  ): readonly string[];
  supportsServiceTier(
    model: string,
    tier: string,
    query?: ModelCatalogRouteQuery,
  ): boolean;
  /** Distinct selectable provider route types with an enabled route. */
  providerTypes(model: string): readonly string[];
  /** The model's Pi admission projection; null outside the catalog. */
  piModel(model: string | null | undefined): PiCatalogModel | null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve a recorded identifier to its catalog model. Every route, enabled or
 * not, names its model: history may carry the upstream ID of a route that is
 * disabled today. An upstream ID shared by several models is ambiguous.
 */
function createIdentifierLookup(
  byModel: ReadonlyMap<string, CatalogModelEntry>,
  routes: readonly CatalogRouteEntry[],
): (identifier: string) => string | undefined {
  const modelsByIdentifier = new Map<string, Set<string>>();
  const addIdentifier = (identifier: string, model: string) => {
    const models = modelsByIdentifier.get(identifier) ?? new Set();
    models.add(model);
    modelsByIdentifier.set(identifier, models);
  };
  for (const route of routes) {
    addIdentifier(route.upstreamModel, route.model);
  }
  for (const model of byModel.keys()) {
    addIdentifier(model, model);
    // Retired Anthropic routes used dotted minor versions upstream. Their
    // routes may be deleted, but the catalog retains the original model name.
    if (model.startsWith("claude-")) {
      addIdentifier(model.replace(/-(\d+)-(\d+)$/u, "-$1.$2"), model);
    }
  }
  return (identifier) => {
    // Operator presets can outlive every current route and catalog version.
    // This is reporting identity only, never selection/admission resolution.
    const autoIdentity: boolean =
      isAutoSelectedModel(identifier) || isAutoRunPreset(identifier);
    if (autoIdentity) {
      return AUTO_SELECTED_MODEL;
    }
    if (byModel.has(identifier)) {
      return identifier;
    }
    const prefix = ["openai/", "anthropic/", "google/", "deepseek/"].find(
      (value) => {
        return identifier.startsWith(value);
      },
    );
    const historicalIdentifier = prefix
      ? identifier.slice(prefix.length)
      : identifier;
    const candidates = new Set([
      ...(modelsByIdentifier.get(identifier) ?? []),
      ...(modelsByIdentifier.get(historicalIdentifier) ?? []),
    ]);
    if (candidates.size !== 1) {
      return undefined;
    }
    const [model] = candidates;
    return model !== undefined && byModel.has(model) ? model : undefined;
  };
}

export function createModelCatalog(
  response: ModelCatalogResponse,
): ModelCatalog {
  const models = [...response.models].sort((left, right) => {
    return left.sortOrder - right.sortOrder;
  });
  const byModel = new Map(
    models.map((entry) => {
      return [entry.model, entry] as const;
    }),
  );
  const routesByModel = new Map<string, CatalogRouteEntry[]>();
  for (const route of response.routes) {
    if (!route.enabled) {
      continue;
    }
    const list = routesByModel.get(route.model) ?? [];
    list.push(route);
    routesByModel.set(route.model, list);
  }
  for (const list of routesByModel.values()) {
    list.sort((left, right) => {
      return left.priority - right.priority;
    });
  }
  const activeModels = models.filter((entry) => {
    return entry.replacedBy === null;
  });
  const routes = (
    model: string,
    query: ModelCatalogRouteQuery = {},
  ): CatalogRouteEntry[] => {
    return (routesByModel.get(model) ?? []).filter((route) => {
      return (
        (!query.providerType || route.providerType === query.providerType) &&
        (!query.concreteProviderType ||
          route.concreteProviderType === query.concreteProviderType)
      );
    });
  };
  const sortOrder = (model: string): number => {
    return byModel.get(model)?.sortOrder ?? Number.POSITIVE_INFINITY;
  };
  const serviceTiers = (model: string, query?: ModelCatalogRouteQuery) => {
    return unique(
      routes(model, query).flatMap((route) => {
        return route.serviceTiers;
      }),
    );
  };
  return {
    models,
    activeModels,
    has(model) {
      return (
        isAutoSelectedModel(model) ||
        (typeof model === "string" && byModel.has(model))
      );
    },
    isActive(model) {
      return (
        isAutoSelectedModel(model) ||
        (typeof model === "string" && byModel.get(model)?.replacedBy === null)
      );
    },
    displayName(model) {
      return isAutoSelectedModel(model)
        ? i18n.t(($) => {
            return $.settings.models.picker.auto;
          })
        : (byModel.get(model)?.displayName ?? model);
    },
    modelForIdentifier: createIdentifierLookup(byModel, response.routes),
    sortOrder,
    compare(left, right) {
      const difference = sortOrder(left) - sortOrder(right);
      if (Number.isNaN(difference) || difference === 0) {
        return left.localeCompare(right);
      }
      return difference;
    },
    resolve(model) {
      if (typeof model !== "string") {
        return undefined;
      }
      return isAutoSelectedModel(model)
        ? model
        : byModel.get(model)?.resolvedModel;
    },
    routes,
    efforts(model, query) {
      return unique(
        routes(model, query).flatMap((route) => {
          return route.efforts;
        }),
      );
    },
    defaultEffort(model, query) {
      return (
        routes(model, query).find((route) => {
          return route.defaultEffort !== null;
        })?.defaultEffort ?? null
      );
    },
    serviceTiers,
    supportsServiceTier(model, tier, query) {
      return serviceTiers(model, query).includes(tier);
    },
    providerTypes(model) {
      return unique(
        routes(model).map((route) => {
          return route.providerType;
        }),
      );
    },
    piModel(model) {
      return piCatalogModel(response, model);
    },
  };
}

const internalReloadModelCatalog$ = state(0);

/** The global run model catalog; identical for every organization. */
export const modelCatalog$ = computed(async (get): Promise<ModelCatalog> => {
  get(internalReloadModelCatalog$);
  const client = get(apiClient$)(modelCatalogContract, { apiBase: "api" });
  const result = await accept(client.get(), [200]);
  return createModelCatalog(result.body);
});

export const invalidateModelCatalog$ = command(({ set }) => {
  set(internalReloadModelCatalog$, (value) => {
    return value + 1;
  });
});
