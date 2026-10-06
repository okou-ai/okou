import {
  getBuiltInRouteProviderVendor,
  getCatalogRunModelRouteAccess,
  isBuiltInModelProviderType,
  isCustomGatewayProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  reasoningEffortSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  catalogBuiltInCandidates,
  type CatalogRoute,
  type ModelCatalog,
} from "./model-catalog.service";

/**
 * Product capabilities of a model come from its catalog routes
 * (`model_routes.efforts`, `default_effort`, `service_tiers`) and plan access
 * from its catalog row. Protocol narrowing per execution (Pi, concrete
 * provider) is applied on top of these by the runtime.
 */

/** Every Built-in provider type selects the catalog's `built-in` routes. */
function catalogProviderType(providerType: string): string {
  return isBuiltInModelProviderType(providerType) ? "built-in" : providerType;
}

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
 * A custom gateway maps catalog models onto its own upstream and has no
 * catalog routes, so it follows the model's catalog capabilities.
 */
function isCustomGatewaySelection(providerType: string): boolean {
  const parsed = modelProviderTypeSchema.safeParse(providerType);
  return parsed.success && isCustomGatewayProviderType(parsed.data);
}

/**
 * The routes that decide a model's capabilities for a selected provider type.
 * Without a provider type, or for a custom gateway, every enabled route of
 * the model counts, Built-in first. Any other provider type uses only its own
 * catalog routes; with none it declares no capabilities.
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
  const selected = catalogProviderType(providerType);
  const matching = routes.filter((route) => {
    return route.providerType === selected;
  });
  if (matching.length > 0) {
    return matching;
  }
  return isCustomGatewaySelection(providerType) ? routes : [];
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

/** Whether any enabled route of the model offers Ultrafast. */
export function catalogModelOffersUltrafast(
  catalog: ModelCatalog,
  model: string | null | undefined,
): boolean {
  return capabilityRoutes(catalog, model, null).some((route) => {
    return route.serviceTiers.includes("ultrafast");
  });
}

/**
 * Ultrafast is offered only by the exact selected route; it never falls back
 * to another route of the model.
 */
export function isCatalogUltrafastServiceTierSupported(
  catalog: ModelCatalog,
  model: string | null | undefined,
  providerType: string | null | undefined,
): boolean {
  if (!model || !providerType) {
    return false;
  }
  const selected = catalogProviderType(providerType);
  return catalog.routes.some((route) => {
    return (
      route.enabled &&
      route.model === model &&
      route.providerType === selected &&
      route.serviceTiers.includes("ultrafast")
    );
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

/** Key-pool vendor of the model's primary Built-in candidate. */
function catalogBuiltInPrimaryVendor(
  catalog: ModelCatalog,
  model: string,
): string {
  const [primary] = catalogBuiltInCandidates(catalog, model);
  const vendor = primary
    ? getBuiltInRouteProviderVendor(primary.concreteProviderType)
    : undefined;
  if (!vendor) {
    throw new Error(`Model "${model}" has no executable Built-in route`);
  }
  return vendor;
}

/** Key-pool vendor that serves the system default on Built-in routes. */
export function loadSystemDefaultBuiltInVendor(
  catalogSnapshot: ModelCatalog,
): string {
  const catalog = catalogSnapshot;
  return catalogBuiltInPrimaryVendor(catalog, catalog.systemDefaultModel);
}

/**
 * Whether an organization's custom gateway may serve the model. A model the
 * catalog offers on its own routes only through the vendor's API and
 * subscription (no third-party gateway route) is not served through custom
 * gateways either; models without own routes are left to the gateway mapping.
 */
