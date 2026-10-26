import { boolean, number, object, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceIoQuotaErrorSchema = apiErrorSchema.extend({
  quota: object({
    count: number(),
    limit: number().nullable(),
  }).optional(),
});

export const audioInputQuotaResponseSchema = object({
  allowed: boolean(),
  count: number().int().nonnegative(),
  limit: number().int().nonnegative().nullable(),
});
export type AudioInputQuotaResponse = zInfer<
  typeof audioInputQuotaResponseSchema
>;

/**
 * Contract for GET /api/voice-io/quota
 *
 * Returns the current audio input quota state for the authenticated org/user.
 * Used by the platform to drive mic-button gating without firing a doomed STT
 * request when a free-tier user has exhausted their quota.
 */
export const voiceIoQuotaContract = c.router({
  get: {
    method: "GET",
    path: "/api/voice-io/quota",
    headers: authHeadersSchema,
    responses: {
      200: audioInputQuotaResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get audio input quota for current org/user",
  },
});

export type VoiceIoQuotaContract = typeof voiceIoQuotaContract;
