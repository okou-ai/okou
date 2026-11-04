import {
  array,
  boolean,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { PI_ROUTE_CLASSES } from "../validators/model-catalog";
export {
  isPiRouteClass,
  type PiRouteClass,
  PI_ROUTE_CLASSES,
} from "../validators/model-catalog";

const c = initContract();

const modelCatalogModelSchema = object({
  model: string(),
  displayName: string(),
  sortOrder: number().int(),
  /** Shared Fast usage metadata for independently shipped native clients. */
  runOptions: object({
    fast: object({ chatGptUsageMultiplier: number().positive() }).optional(),
  }).optional(),
  /** Direct replacement of a retired model; null when the model is active. */
  replacedBy: string().nullable(),
  /**
   * The final active model a stored selection of this model resolves to,
   * following the whole replacement chain.
   */
  resolvedModel: string(),
  /**
   * Plan policy for organizations whose plan restricts Built-in models:
   * whether they may run this model on a Built-in route. Only a member's
   * connected personal subscription on the model's catalog subscription route
   * is allowed otherwise.
   */
  builtInOnRestrictedPlans: boolean(),
  /**
   * Which family of Pi route rules admits the model; null when the model is
   * not Pi-eligible and always runs on its vendor harness.
   */
  piRouteClass: zEnum(PI_ROUTE_CLASSES).nullable(),
});

const modelCatalogRouteSchema = object({
  model: string(),
  providerType: string(),
  concreteProviderType: string(),
  subscriptionType: string().nullable(),
  upstreamModel: string(),
  enabled: boolean(),
  priority: number().int(),
  serviceTiers: array(string()),
  defaultServiceTier: string().nullable(),
  efforts: array(string()),
  defaultEffort: string().nullable(),
  /** Whether this route is supported by the current Pi runtime catalog. */
  piRuntimeCapable: boolean().optional(),
});

export const modelCatalogResponseSchema = object({
  models: array(modelCatalogModelSchema),
  routes: array(modelCatalogRouteSchema),
  /** The model every organization uses without a thread or member choice. */
  systemDefaultModel: string(),
});

export type ModelCatalogResponse = zInfer<typeof modelCatalogResponseSchema>;

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
