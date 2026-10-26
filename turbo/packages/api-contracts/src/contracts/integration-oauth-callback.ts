import { literal, object, string, union, url } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const integrationOAuthCallbackQuerySchema = object({
  responseMode: literal("json").optional(),
  code: string().optional(),
  error: string().optional(),
  state: string().optional(),
});

const providerErrorSchema = object({ error: string() });
const integrationOAuthCallbackResponseSchema = object({
  redirectUrl: url(),
});

export const integrationOAuthCallbackResponses = {
  200: integrationOAuthCallbackResponseSchema,
  307: initContract().noBody(),
  400: providerErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  503: union([providerErrorSchema, apiErrorSchema]),
} as const;
