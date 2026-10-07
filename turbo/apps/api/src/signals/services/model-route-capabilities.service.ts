import { getCatalogRunModelRouteAccess } from "@okouai/api-contracts/contracts/model-providers";
import {
  reasoningEffortSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { CatalogRoute, ModelCatalog } from "./model-catalog.service";

/**
 * Product capabilities of a model come from its catalog routes
 * (`model_routes.efforts`, `default_effort`, `service_tiers`) and plan access
 * from its catalog row. Protocol narrowing per execution (Pi, concrete
 * provider) is applied on top of these by the runtime.
 */

function enabledRoutes(
  catalog: ModelCatalog,
  model: string,
): readonly CatalogRoute[] {
  return catalog.routes
    .filter((route) => {
      return route.enabled && route.model === model;
    })
    .sort((left, right) => {
      const leftBuiltIn = left.providerType === "built-in" ? 0 : 1;
      const rightBuiltIn = right.providerType === "built-in" ? 0 : 1;
      return leftBuiltIn - rightBuiltIn || left.priority - right.priority;
    });
}

/**
 * The routes that decide a model's capabilities for a selected provider type.
 * Without a provider type, every enabled route of the model counts, Built-in
 * first. A provider type uses only its own catalog routes; with none it
 * declares no capabilities.
 */
function capabilityRoutes(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType: string | null | undefined,
): readonly CatalogRoute[] {
  if (!model) {
    return [];
  }
  const routes = enabledRoutes(catalog, model);
  if (!providerType) {
    return routes;
  }
  return routes.filter((route) => {
    return route.providerType === providerType;
  });
}

function parseEfforts(values: readonly string[]): readonly ReasoningEffort[] {
  return values.flatMap((value) => {
    const parsed = reasoningEffortSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Reasoning efforts accepted for a model on the selected route. */
export function catalogRouteEfforts(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType?: string | null,
): readonly ReasoningEffort[] {
  return [
    ...new Set(
      parseEfforts(
        capabilityRoutes(catalog, model, providerType).flatMap((route) => {
          return route.efforts;
        }),
      ),
    ),
  ];
}

/** The launch default effort of the selected route, if it has one. */
export function catalogRouteDefaultEffort(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType?: string | null,
): ReasoningEffort | undefined {
  const route = capabilityRoutes(catalog, model, providerType).find(
    (candidate) => {
      return candidate.defaultEffort !== null;
    },
  );
  const parsed = reasoningEffortSchema.safeParse(route?.defaultEffort);
  return parsed.success ? parsed.data : undefined;
}

export function isCatalogRouteEffortSupported(
  catalog: ModelCatalog,
  model: string | null | undefined,
  effort: ReasoningEffort,
  providerType?: string | null,
): boolean {
  return catalogRouteEfforts(catalog, model, providerType).includes(effort);
}

/**
 * One model's effort from its saved preference: the saved value while the
 * route accepts it, otherwise the route's default. Never borrows another
 * model's value.
 */
export function catalogModelReasoningEffort(
  catalog: ModelCatalog,
  model: string | null | undefined,
  settings: ModelSettings | null | undefined,
  providerType?: string | null,
): ReasoningEffort | undefined {
  if (!model) {
    return undefined;
  }
  const saved = settings?.[model]?.effort;
  if (
    saved !== undefined &&
    isCatalogRouteEffortSupported(catalog, model, saved, providerType)
  ) {
    return saved;
  }
  return catalogRouteDefaultEffort(catalog, model, providerType);
}

/**
 * Whether the Codex Fast (`priority`) tier is offered for a model on the
 * selected route.
 */
export function isCatalogFastServiceTierSupported(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType?: string | null,
): boolean {
  return capabilityRoutes(catalog, model, providerType).some((route) => {
    return route.serviceTiers.includes("priority");
  });
}

/**
 * The catalog model a selected ID names: the catalog model itself, or the one
 * catalog model whose route `upstream_model` it is (a provider-prefixed ID
 * such as `deepseek/deepseek-v4-flash`). An upstream ID shared by several
 * catalog models, or any other ID, names no catalog model. Replacement is not
 * followed here.
 */
export function catalogModelForSelectedId(
  catalog: ModelCatalog,
  selectedId: string,
): string | null {
  const id = selectedId.trim();
  if (catalog.byModel.has(id)) {
    return id;
  }
  const models = new Set(
    catalog.routes
      .filter((route) => {
        return route.upstreamModel === id;
      })
      .map((route) => {
        return route.model;
      }),
  );
  const [only] = models;
  return models.size === 1 && only !== undefined ? only : null;
}

/**
 * Plan access of a model on a route, from the model's catalog row. A selected
 * ID is normalized through the catalog first (see
 * `catalogModelForSelectedId`). A model outside the catalog is never allowed
 * on a restricted Built-in route.
 */
export function catalogRunModelRouteAccess(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType: string | null | undefined,
  restrictedBuiltInModels = false,
): "allowed" | "pro_required" {
  if (!model?.trim()) {
    return "allowed";
  }
  return getCatalogRunModelRouteAccess(
    catalog.byModel.get(catalogModelForSelectedId(catalog, model) ?? ""),
    providerType,
    restrictedBuiltInModels,
  );
}
