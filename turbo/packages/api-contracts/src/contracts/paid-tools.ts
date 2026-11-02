import { array, boolean, object, string, type infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
export { AVAILABLE_PAID_TOOL_IDS } from "../validators/paid-tools";

/**
 * Okou-owned tools and Data Router family IDs share one sparse namespace of
 * disabled preferences. Router owns family IDs, so Okou validates only their
 * format; retired and unknown IDs stay parseable and simply match nothing.
 */
export const paidToolIdSchema = string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type PaidToolId = zInfer<typeof paidToolIdSchema>;

export const DISABLED_PAID_TOOLS_ENV_VAR = "OKOU_DISABLED_PAID_TOOLS";
export const ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR =
  "OKOU_ENABLE_FRAMEWORK_WEB_SEARCH";
export const ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR =
  "OKOU_ENABLE_FRAMEWORK_IMAGE_GENERATION";

const c = initContract();

export const paidToolsContract = c.router({
  get: {
    method: "GET",
    path: "/api/paid-tools",
    headers: authHeadersSchema,
    responses: {
      // Lists remain additive when a newer API supports more tools.
      200: object({ disabledTools: array(string()) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get paid tools disabled by the current workspace member",
  },
  update: {
    method: "PATCH",
    path: "/api/paid-tools/:toolId",
    headers: authHeadersSchema,
    pathParams: object({ toolId: paidToolIdSchema }),
    body: object({ disabled: boolean() }).strict(),
    responses: {
      200: object({ toolId: paidToolIdSchema, disabled: boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disable or enable one paid tool for the current workspace member",
  },
});
