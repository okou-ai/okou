import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { realtimeSubscriptionSchema } from "./realtime";

const c = initContract();

export const builtInGenerationTypeSchema = z.enum([
  "image",
  "video",
  "presentation",
  "website",
]);

export const builtInGenerationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export const builtInGenerationRealtimeSubscriptionSchema =
  realtimeSubscriptionSchema;

export const builtInGenerationAcceptedResponseSchema = z.object({
  generationId: z.string().uuid(),
  type: builtInGenerationTypeSchema,
  status: z.literal("queued"),
  realtime: builtInGenerationRealtimeSubscriptionSchema,
});

export const builtInGenerationErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
});

export const builtInGenerationResponseSchema = z.object({
  generationId: z.string().uuid(),
  type: builtInGenerationTypeSchema,
  status: builtInGenerationStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  error: builtInGenerationErrorSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export type BuiltInGenerationType = z.infer<typeof builtInGenerationTypeSchema>;
export type BuiltInGenerationStatus = z.infer<
  typeof builtInGenerationStatusSchema
>;
export type BuiltInGenerationRealtimeSubscription = z.infer<
  typeof builtInGenerationRealtimeSubscriptionSchema
>;
export type BuiltInGenerationAcceptedResponse = z.infer<
  typeof builtInGenerationAcceptedResponseSchema
>;
export type BuiltInGenerationResponse = z.infer<
  typeof builtInGenerationResponseSchema
>;

export const builtInGenerationContract = c.router({
  get: {
    method: "GET",
    path: "/api/built-in-generations/:generationId",
    headers: authHeadersSchema,
    pathParams: z.object({
      generationId: z.string().uuid(),
    }),
    responses: {
      200: builtInGenerationResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a built-in generation job",
  },
});

export type BuiltInGenerationContract = typeof builtInGenerationContract;
