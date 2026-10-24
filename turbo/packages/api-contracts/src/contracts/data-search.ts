import { z } from "zod";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const dataSearchRequestSchema = z
  .object({
    capability: z.string().trim().min(1).max(128),
    input: z.record(z.string(), z.json()),
    limit: safeInteger.min(1).max(1_000).default(10),
  })
  .strict();

export const dataSearchCreateRequestSchema = dataSearchRequestSchema.extend({
  requestId: z.uuid(),
  maxCredits: safeInteger,
});

export const dataSearchJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

export const dataSearchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
  status: dataSearchJobStatusSchema.optional(),
});

export type DataSearchRequest = z.infer<typeof dataSearchRequestSchema>;

export type DataSearchCreateRequest = z.infer<
  typeof dataSearchCreateRequestSchema
>;

export type DataSearchListQuery = z.infer<typeof dataSearchListQuerySchema>;
