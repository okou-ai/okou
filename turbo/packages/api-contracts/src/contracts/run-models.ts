import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { availableRunModelsResponseSchema } from "./model-providers";

const c = initContract();
export const runModelsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/run-models",
    headers: authHeadersSchema,
    responses: {
      200: availableRunModelsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List Auto and the member's personal subscription models",
  },
});
export type RunModelsMainContract = typeof runModelsMainContract;
