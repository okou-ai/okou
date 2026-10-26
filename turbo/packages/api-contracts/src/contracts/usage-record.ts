import {
  array,
  coerce,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const usageRecordScopeSchema = zEnum(["mine", "team"]);
export type UsageRecordScope = zInfer<typeof usageRecordScopeSchema>;

export const usageRecordRangeSchema = zEnum([
  "today",
  "yesterday",
  "24h",
  "7d",
  "billingPeriod",
]);
export type UsageRecordRange = zInfer<typeof usageRecordRangeSchema>;

export const usageRecordKindSchema = zEnum([
  "model",
  "image",
  "video",
  "connector",
  "other",
]);
export type UsageRecordKind = zInfer<typeof usageRecordKindSchema>;

export const usageRecordProviderBreakdownSchema = object({
  // Captured ledger provider for every usage kind. Clients resolve model aliases
  // through the product catalog for display; reporting does not rewrite billing.
  provider: string(),
  credits: number(),
  usageKinds: array(
    object({
      kind: string(),
      credits: number(),
    }),
  ),
});

export const usageRecordKindBreakdownSchema = object({
  kind: usageRecordKindSchema,
  credits: number(),
  providers: array(usageRecordProviderBreakdownSchema),
});

export type UsageRecordKindBreakdown = zInfer<
  typeof usageRecordKindBreakdownSchema
>;

const usageRecordMemberSchema = object({
  userId: string(),
  email: string(),
});

// One usage row. Every run with a thread id aggregates into one row per
// user/thread, independent of trigger source. Historical usage without a
// recoverable thread id aggregates into one non-navigable fallback row.
const usageRecordRowSchema = object({
  // Set for navigable thread usage.
  threadId: string().nullable(),
  title: string().nullable(),
  credits: number(),
  tokens: number(),
  breakdown: array(usageRecordKindBreakdownSchema),
  member: usageRecordMemberSchema.nullable(),
  // ISO string of the most recent run in this row.
  lastActivityAt: string(),
});

const usageRecordResponseSchema = object({
  period: object({
    start: string(),
    end: string(),
  }).nullable(),
  rows: array(usageRecordRowSchema),
  // Total credits across the whole range (not just the current page), so the
  // summary headline stays correct as more pages load in.
  totalCredits: number(),
  pagination: object({
    page: number(),
    pageSize: number(),
    total: number(),
  }),
});

export const usageRecordContract = c.router({
  get: {
    method: "GET",
    path: "/api/usage/record",
    headers: authHeadersSchema,
    query: object({
      page: coerce.number().int().positive().default(1),
      pageSize: coerce.number().int().positive().max(100).default(20),
      scope: usageRecordScopeSchema.default("mine"),
      range: usageRecordRangeSchema.default("today"),
      tz: string().default("UTC"),
    }),
    responses: {
      200: usageRecordResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get personal usage records across sources, ordered by recent activity",
  },
});

export type UsageRecordContract = typeof usageRecordContract;
export type UsageRecordResponse = zInfer<typeof usageRecordResponseSchema>;
export type UsageRecordRow = zInfer<typeof usageRecordRowSchema>;
