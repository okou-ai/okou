import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** The Pi route classes `run_model_catalog.pi_route_class` may hold. */
export const PI_ROUTE_CLASSES = [
  "claude-native",
  "gpt-codex",
  "deepseek",
] as const;

export type PiRouteClass = (typeof PI_ROUTE_CLASSES)[number];

export function isPiRouteClass(value: unknown): value is PiRouteClass {
  return PI_ROUTE_CLASSES.some((routeClass) => {
    return routeClass === value;
  });
}

const modelCatalogModelSchema = z.object({
  model: z.string(),
  displayName: z.string(),
  sortOrder: z.number().int(),
  isSystemDefault: z.boolean(),
  /** Direct replacement of a retired model; null when the model is active. */
  replacedBy: z.string().nullable(),
  /**
   * The final active model a stored selection of this model resolves to,
   * following the whole replacement chain.
   */
  resolvedModel: z.string(),
  /** Display price tier of the model's Built-in route; null without one. */
  priceTier: z.string().nullable(),
  /**
   * Plan policy for organizations whose plan restricts Built-in models:
   * whether they may run this model on a Built-in route.
   */
  builtInOnRestrictedPlans: z.boolean(),
  /**
   * The same plan policy for routes the organization or member provides
   * (BYOK, personal subscriptions and custom gateways).
   */
  ownRoutesOnRestrictedPlans: z.boolean(),
  /**
   * Which family of Pi route rules admits the model; null when the model is
   * not Pi-eligible and always runs on its vendor harness.
   */
  piRouteClass: z.enum(PI_ROUTE_CLASSES).nullable(),
});

const modelCatalogRouteSchema = z.object({
  model: z.string(),
  providerType: z.string(),
  concreteProviderType: z.string(),
  subscriptionType: z.string().nullable(),
  upstreamModel: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  serviceTiers: z.array(z.string()),
  defaultServiceTier: z.string().nullable(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
  priceTier: z.string().nullable(),
});

export const modelCatalogResponseSchema = z.object({
  models: z.array(modelCatalogModelSchema),
  routes: z.array(modelCatalogRouteSchema),
  /** The model every organization uses without a thread or member choice. */
  systemDefaultModel: z.string(),
});

export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

export const modelCatalogContract = c.router({
  get: {
    method: "GET",
    path: "/api/model-catalog",
    headers: authHeadersSchema,
    responses: {
      200: modelCatalogResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read the global run model catalog and its routes",
  },
});

export type ModelCatalogContract = typeof modelCatalogContract;

const THIRD_PARTY_GATEWAY_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "openrouter-api-key",
  "vercel-ai-gateway",
  "openrouter-codex",
  "vercel-ai-gateway-codex",
]);

/**
 * Whether an organization's custom gateway may serve a model, from the
 * provider types of the model's enabled non-Built-in routes. A model offered
 * on its own routes only through the vendor's API and subscription (no
 * third-party gateway route) is not served through custom gateways either;
 * models without own routes are left to the gateway mapping.
 */
export function ownRoutesAllowCustomGateway(
  ownRouteProviderTypes: readonly string[],
): boolean {
  return (
    ownRouteProviderTypes.length === 0 ||
    ownRouteProviderTypes.some((providerType) => {
      return THIRD_PARTY_GATEWAY_PROVIDER_TYPES.has(providerType);
    })
  );
}
