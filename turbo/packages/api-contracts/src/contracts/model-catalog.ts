import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const modelCatalogModelSchema = z.object({
  model: z.string(),
  displayName: z.string(),
  sortOrder: z.number().int(),
  isSystemDefault: z.boolean(),
  /** Direct replacement of a retired model; null when the model is active. */
  replacedBy: z.string().nullable(),
  /** The active model a stored selection of this model resolves to. */
  resolvedModel: z.string(),
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
