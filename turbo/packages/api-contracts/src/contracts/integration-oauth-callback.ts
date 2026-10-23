import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const integrationOAuthCallbackQuerySchema = z.object({
  responseMode: z.literal("json").optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
});

const providerErrorSchema = z.object({ error: z.string() });
const integrationOAuthCallbackResponseSchema = z.object({
  redirectUrl: z.url(),
});

export const integrationOAuthCallbackResponses = {
  200: integrationOAuthCallbackResponseSchema,
  307: initContract().noBody(),
  400: providerErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  503: z.union([providerErrorSchema, apiErrorSchema]),
} as const;
