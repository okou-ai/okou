import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
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
export const dataSearchQuoteResponseSchema = z.object({
  capability: z.string(),
  estimatedCredits: safeInteger,
  maxCredits: safeInteger,
  quantity: safeInteger,
  unit: z.enum(["request", "result", "metric", "channel"]),
});
export const dataSearchCapabilitySchema = z.object({
  id: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.json()),
  limits: z.object({ default: safeInteger, max: safeInteger }),
  status: z.enum(["available", "unavailable"]),
});
export const dataSearchCapabilitiesResponseSchema = z.object({
  capabilities: z.array(dataSearchCapabilitySchema),
});
export const dataSearchJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export const dataSearchJobResponseSchema = z.object({
  jobId: z.uuid(),
  requestId: z.uuid(),
  capability: z.string(),
  status: dataSearchJobStatusSchema,
  data: z.object({ items: z.array(z.json()) }).nullable(),
  billing: z.object({
    state: z.enum(["pending", "settled"]),
    creditsCharged: safeInteger,
    reservedCredits: safeInteger,
    maxCredits: safeInteger,
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const dataSearchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
  status: dataSearchJobStatusSchema.optional(),
});
export const dataSearchListResponseSchema = z.object({
  jobs: z.array(dataSearchJobResponseSchema),
  nextCursor: z.uuid().nullable(),
});
export type DataSearchRequest = z.infer<typeof dataSearchRequestSchema>;
export type DataSearchCreateRequest = z.infer<
  typeof dataSearchCreateRequestSchema
>;
export type DataSearchQuoteResponse = z.infer<
  typeof dataSearchQuoteResponseSchema
>;
export type DataSearchCapability = z.infer<typeof dataSearchCapabilitySchema>;
export type DataSearchCapabilitiesResponse = z.infer<
  typeof dataSearchCapabilitiesResponseSchema
>;
export type DataSearchJobResponse = z.infer<typeof dataSearchJobResponseSchema>;
export type DataSearchListQuery = z.infer<typeof dataSearchListQuerySchema>;
export type DataSearchListResponse = z.infer<
  typeof dataSearchListResponseSchema
>;
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  422: apiErrorSchema,
  429: apiErrorSchema,
  500: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
};
const jobParams = z.object({ jobId: z.uuid() });
export const dataSearchContract = c.router({
  capabilities: {
    method: "GET",
    path: "/api/data/capabilities",
    headers: authHeadersSchema,
    query: z.object({ query: z.string().optional() }),
    responses: { 200: dataSearchCapabilitiesResponseSchema, ...errors },
    summary: "List reviewed business data capabilities",
  },
  quote: {
    method: "POST",
    path: "/api/data/quote",
    headers: authHeadersSchema,
    body: dataSearchRequestSchema,
    responses: { 200: dataSearchQuoteResponseSchema, ...errors },
    summary: "Quote a bounded Data Search operation",
  },
  create: {
    method: "POST",
    path: "/api/data/jobs",
    headers: authHeadersSchema,
    body: dataSearchCreateRequestSchema,
    responses: { 202: dataSearchJobResponseSchema, ...errors },
    summary: "Create an idempotent budgeted Data Search job",
  },
  list: {
    method: "GET",
    path: "/api/data/jobs",
    headers: authHeadersSchema,
    query: dataSearchListQuerySchema,
    responses: { 200: dataSearchListResponseSchema, ...errors },
    summary: "List your saved Data Search jobs",
  },
  get: {
    method: "GET",
    path: "/api/data/jobs/:jobId",
    headers: authHeadersSchema,
    pathParams: jobParams,
    responses: { 200: dataSearchJobResponseSchema, ...errors },
    summary: "Read a saved Data Search job",
  },
  cancel: {
    method: "POST",
    path: "/api/data/jobs/:jobId/cancel",
    headers: authHeadersSchema,
    pathParams: jobParams,
    body: z.object({}).strict(),
    responses: { 200: dataSearchJobResponseSchema, ...errors },
    summary: "Cancel a Data Search job without promising a refund",
  },
  quoteContinuation: {
    method: "POST",
    path: "/api/data/jobs/:jobId/continue/quote",
    headers: authHeadersSchema,
    pathParams: jobParams,
    body: z.object({}).strict(),
    responses: { 200: dataSearchQuoteResponseSchema, ...errors },
    summary:
      "Reject continuation unless a trusted source cursor is available (422)",
  },
  continue: {
    method: "POST",
    path: "/api/data/jobs/:jobId/continue",
    headers: authHeadersSchema,
    pathParams: jobParams,
    body: z.object({ requestId: z.uuid(), maxCredits: safeInteger }).strict(),
    responses: { 202: dataSearchJobResponseSchema, ...errors },
    summary: "Continue only with a trusted saved source cursor; otherwise 422",
  },
});
