import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { z } from "zod";
import {
  orgModelModeSchema,
  orgModelPoliciesResponseSchema,
  updateOrgModelPoliciesRequestSchema,
} from "./model-providers";

const c = initContract();

export const modelPoliciesMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/model-policies",
    headers: authHeadersSchema,
    responses: {
      200: orgModelPoliciesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org model-first policies",
  },
  updateMode: {
    method: "PUT",
    path: "/api/model-policies/mode",
    headers: authHeadersSchema,
    body: z.object({ mode: orgModelModeSchema }),
    responses: {
      200: z.object({ mode: orgModelModeSchema }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the org model settings mode",
  },
  update: {
    method: "PUT",
    path: "/api/model-policies",
    headers: authHeadersSchema,
    body: updateOrgModelPoliciesRequestSchema,
    responses: {
      200: orgModelPoliciesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      409: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update org model-first policies",
  },
});

export type ModelPoliciesMainContract = typeof modelPoliciesMainContract;
