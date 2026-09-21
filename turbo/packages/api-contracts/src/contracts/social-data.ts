import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SOCIAL_DATA_MAX_RESULTS = 1_000;

export const socialDataPlatformSchema = z.enum([
  "x",
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
]);

export const socialDataOperationSchema = z.enum([
  "inspect",
  "posts",
  "search",
  "comments",
  "transcript",
]);

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = safeInteger.min(1);
const publicUrl = z
  .url()
  .max(4_096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.port
    );
  }, "Use a public HTTPS social URL without credentials or a port");

const socialDataInputSchema = z
  .object({
    operation: socialDataOperationSchema,
    platform: socialDataPlatformSchema,
    url: publicUrl.optional(),
    query: z.string().trim().min(1).max(1_000).optional(),
    limit: positiveInteger.max(SOCIAL_DATA_MAX_RESULTS).default(10),
    kind: z.enum(["posts", "reels"]).optional(),
    sort: z.string().trim().min(1).max(32).optional(),
    date: z.string().trim().min(1).max(64).optional(),
    type: z.enum(["video", "shorts"]).optional(),
    hashtag: z.boolean().optional(),
    fullDetails: z.boolean().optional(),
    refresh: z.boolean().optional(),
    thread: z.boolean().optional(),
    requireViews: z.boolean().optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/u)
      .optional(),
  })
  .strict();

function validateTarget(
  input: z.infer<typeof socialDataInputSchema>,
  context: z.RefinementCtx,
) {
  if (input.operation === "search") {
    if (input.query === undefined || input.url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Search requires a query and does not accept a URL",
      });
    }
  } else if (input.url === undefined || input.query !== undefined) {
    context.addIssue({
      code: "custom",
      message: "This operation requires a URL and does not accept a query",
    });
  }
}

export const socialDataRequestSchema =
  socialDataInputSchema.superRefine(validateTarget);

export const socialDataCreateRequestSchema = socialDataInputSchema
  .extend({
    requestId: z.uuid(),
    maxCredits: positiveInteger.optional(),
  })
  .superRefine(validateTarget);

export const socialDataQuoteResponseSchema = z.object({
  platform: socialDataPlatformSchema,
  operation: socialDataOperationSchema,
  estimatedCredits: safeInteger,
  maxCredits: safeInteger,
  quantity: positiveInteger,
  unit: z.enum(["request", "result"]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export const socialDataRecordSchema = z.object({
  id: z.string().optional(),
  url: z.url().optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  publishedAt: z.string().optional(),
  username: z.string().optional(),
  displayName: z.string().optional(),
  followers: safeInteger.optional(),
  following: safeInteger.optional(),
  posts: safeInteger.optional(),
  views: safeInteger.optional(),
  likes: safeInteger.optional(),
  reactions: safeInteger.optional(),
  comments: safeInteger.optional(),
  shares: safeInteger.optional(),
  replies: safeInteger.optional(),
  duration: z.number().nonnegative().optional(),
  mediaUrls: z.array(z.url()).optional(),
  parentId: z.string().optional(),
});

export const socialDataResultSchema = z.union([
  z.object({ items: z.array(socialDataRecordSchema) }),
  z.object({
    transcript: z.string(),
    segments: z
      .array(
        z.object({
          text: z.string(),
          start: z.number().nonnegative().optional(),
          duration: z.number().nonnegative().optional(),
        }),
      )
      .optional(),
    language: z.string().optional(),
  }),
]);

export const socialDataJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

export const socialDataJobResponseSchema = z.object({
  jobId: z.uuid(),
  requestId: z.uuid(),
  platform: socialDataPlatformSchema,
  operation: socialDataOperationSchema,
  status: socialDataJobStatusSchema,
  data: socialDataResultSchema.nullable(),
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

export const socialDataListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

export const socialDataListResponseSchema = z.object({
  jobs: z.array(socialDataJobResponseSchema),
  nextCursor: z.uuid().nullable(),
});

export type SocialDataPlatform = z.infer<typeof socialDataPlatformSchema>;
export type SocialDataOperation = z.infer<typeof socialDataOperationSchema>;
export type SocialDataRequest = z.infer<typeof socialDataRequestSchema>;
export type SocialDataCreateRequest = z.infer<
  typeof socialDataCreateRequestSchema
>;
export type SocialDataQuoteResponse = z.infer<
  typeof socialDataQuoteResponseSchema
>;
export type SocialDataRecord = z.infer<typeof socialDataRecordSchema>;
export type SocialDataResult = z.infer<typeof socialDataResultSchema>;
export type SocialDataJobResponse = z.infer<typeof socialDataJobResponseSchema>;
export type SocialDataListQuery = z.infer<typeof socialDataListQuerySchema>;
export type SocialDataListResponse = z.infer<
  typeof socialDataListResponseSchema
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

export const socialDataContract = c.router({
  quote: {
    method: "POST",
    path: "/api/social/data/quote",
    headers: authHeadersSchema,
    body: socialDataRequestSchema,
    responses: { 200: socialDataQuoteResponseSchema, ...errors },
    summary: "Quote a bounded public Social data operation without billing",
  },
  create: {
    method: "POST",
    path: "/api/social/data/jobs",
    headers: authHeadersSchema,
    body: socialDataCreateRequestSchema,
    responses: { 202: socialDataJobResponseSchema, ...errors },
    summary: "Create an idempotent, budget-limited Social data job",
  },
  list: {
    method: "GET",
    path: "/api/social/data/jobs",
    headers: authHeadersSchema,
    query: socialDataListQuerySchema,
    responses: { 200: socialDataListResponseSchema, ...errors },
    summary: "List the current user's saved Social data jobs",
  },
  get: {
    method: "GET",
    path: "/api/social/data/jobs/:jobId",
    headers: authHeadersSchema,
    pathParams: z.object({ jobId: z.uuid() }),
    responses: { 200: socialDataJobResponseSchema, ...errors },
    summary: "Read a saved Social data job without starting another operation",
  },
  cancel: {
    method: "POST",
    path: "/api/social/data/jobs/:jobId/cancel",
    headers: authHeadersSchema,
    pathParams: z.object({ jobId: z.uuid() }),
    body: z.object({}).strict(),
    responses: { 200: socialDataJobResponseSchema, ...errors },
    summary: "Cancel a Social data job and retain its delivered results",
  },
});
