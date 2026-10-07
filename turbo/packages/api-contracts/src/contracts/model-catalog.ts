import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** The Pi route classes `run_model_catalog.pi_route_class` may hold. */
export const PI_ROUTE_CLASSES = ["gpt-codex"] as const;

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
  /** Direct replacement of a retired model; null when the model is active. */
  replacedBy: z.string().nullable(),
  /**
   * The final active model a stored selection of this model resolves to,
   * following the whole replacement chain.
   */
  resolvedModel: z.string(),
  /**
   * Plan policy for organizations whose plan restricts Built-in models:
   * whether they may run this model on a Built-in route. Only a member's
   * connected personal subscription on the model's catalog subscription route
   * is allowed otherwise.
   */
  builtInOnRestrictedPlans: z.boolean(),
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
