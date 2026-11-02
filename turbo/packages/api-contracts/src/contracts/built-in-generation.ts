import {
  literal,
  object,
  record,
  string,
  uuid,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { realtimeSubscriptionSchema } from "./realtime";

const c = initContract();

export const builtInGenerationTypeSchema = zEnum([
  "image",
  "video",
  "presentation",
  "website",
]);

export const builtInGenerationStatusSchema = zEnum([
  "queued",
  "running",
  "completed",
  "failed",
]);

export const builtInGenerationRealtimeSubscriptionSchema =
  realtimeSubscriptionSchema;

export const builtInGenerationAcceptedResponseSchema = object({
  generationId: uuid(),
  type: builtInGenerationTypeSchema,
  status: literal("queued"),
  realtime: builtInGenerationRealtimeSubscriptionSchema,
  // Present only for jobs supporting explicit owner-driven advancement.
  // Legacy jobs continue through their existing worker/webhook and GET flow.
  clientReconciliation: literal(true).optional(),
});

export const builtInGenerationErrorSchema = object({
  message: string(),
  code: string(),
});

export const builtInGenerationResponseSchema = object({
  generationId: uuid(),
  type: builtInGenerationTypeSchema,
  status: builtInGenerationStatusSchema,
  result: record(string(), zUnknown()).optional(),
  error: builtInGenerationErrorSchema.optional(),
  createdAt: string(),
  startedAt: string().nullable(),
  completedAt: string().nullable(),
});

export type BuiltInGenerationType = zInfer<typeof builtInGenerationTypeSchema>;
export type BuiltInGenerationStatus = zInfer<
  typeof builtInGenerationStatusSchema
>;
export type BuiltInGenerationRealtimeSubscription = zInfer<
  typeof builtInGenerationRealtimeSubscriptionSchema
>;
export type BuiltInGenerationAcceptedResponse = zInfer<
  typeof builtInGenerationAcceptedResponseSchema
>;
export type BuiltInGenerationResponse = zInfer<
  typeof builtInGenerationResponseSchema
>;

export const builtInGenerationContract = c.router({
  reconcile: {
    method: "POST",
    path: "/api/built-in-generations/:generationId/reconcile",
    headers: authHeadersSchema,
    pathParams: object({ generationId: uuid() }),
    body: object({}),
    responses: {
      200: builtInGenerationResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Advance an owned image job once without submitting another image",
  },
  get: {
    method: "GET",
    path: "/api/built-in-generations/:generationId",
    headers: authHeadersSchema,
    pathParams: object({
      generationId: uuid(),
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
