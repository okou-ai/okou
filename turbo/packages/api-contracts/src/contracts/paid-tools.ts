import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const PAID_TOOL_IDS = [
  "web-search",
  "people-search",
  "scrape",
  "finance",
  "maps",
  "seo",
  "social",
  "image-recognition",
  "image-generation",
  "video-generation",
  "voice-generation",
  "avatar-video-generation",
  "video-rendering",
] as const;

export const paidToolIdSchema = z.enum(PAID_TOOL_IDS);
export type PaidToolId = z.infer<typeof paidToolIdSchema>;

export const DISABLED_PAID_TOOLS_ENV_VAR = "OKOU_DISABLED_PAID_TOOLS";

const c = initContract();

export const paidToolsContract = c.router({
  get: {
    method: "GET",
    path: "/api/paid-tools",
    headers: authHeadersSchema,
    responses: {
      // Lists remain additive when a newer API supports more tools.
      200: z.object({ disabledTools: z.array(z.string()) }),
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
    pathParams: z.object({ toolId: paidToolIdSchema }),
    body: z.object({ disabled: z.boolean() }).strict(),
    responses: {
      200: z.object({ toolId: paidToolIdSchema, disabled: z.boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disable or enable one paid tool for the current workspace member",
  },
});
