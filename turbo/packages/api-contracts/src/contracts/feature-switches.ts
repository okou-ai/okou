import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const featureSwitchesResponseSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
  effectiveSwitches: z.record(z.string(), z.boolean()),
});

export type FeatureSwitchesResponse = z.infer<
  typeof featureSwitchesResponseSchema
>;

export const updateFeatureSwitchesRequestSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
});

export type UpdateFeatureSwitchesRequest = z.infer<
  typeof updateFeatureSwitchesRequestSchema
>;

/**
 * Feature switches contract for /api/feature-switches
 *
 * GET: Get current user's feature switch overrides plus org-scoped overrides.
 * POST: Update feature switch overrides (merge strategy). Some switches may be
 * stored at org scope.
 * DELETE: Remove current user's overrides plus org-scoped overrides controlled
 * by this endpoint.
 */
export const featureSwitchesContract = c.router({
  get: {
    method: "GET",
    path: "/api/feature-switches",
    headers: authHeadersSchema,
    responses: {
      200: featureSwitchesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get feature switch overrides",
  },
  update: {
    method: "POST",
    path: "/api/feature-switches",
    headers: authHeadersSchema,
    body: updateFeatureSwitchesRequestSchema,
    responses: {
      200: featureSwitchesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update feature switch overrides",
  },
  delete: {
    method: "DELETE",
    path: "/api/feature-switches",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: z.object({ deleted: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete feature switch overrides",
  },
});

export type FeatureSwitchesContract = typeof featureSwitchesContract;
