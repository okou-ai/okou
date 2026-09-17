import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
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
