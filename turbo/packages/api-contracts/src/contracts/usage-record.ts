import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Where a run originated. `chat` is web chat (trigger_source 'web'); known
// trigger sources keep their surface, and unsupported values are grouped as
// `other`.
export const usageRecordSourceSchema = z.enum([
  "chat",
  "automation",
  "slack",
  "teams",
  "telegram",
  "email",
  "agentphone",
  "github",
  "agent",
  "other",
]);

export type UsageRecordSource = z.infer<typeof usageRecordSourceSchema>;

export const usageRecordScopeSchema = z.enum(["mine", "team"]);
export type UsageRecordScope = z.infer<typeof usageRecordScopeSchema>;

export const usageRecordRangeSchema = z.enum([
  "today",
  "yesterday",
  "24h",
  "7d",
  "billingPeriod",
]);
export type UsageRecordRange = z.infer<typeof usageRecordRangeSchema>;

export const usageRecordKindSchema = z.enum([
  "model",
  "image",
  "video",
  "connector",
  "other",
]);
export type UsageRecordKind = z.infer<typeof usageRecordKindSchema>;

export const usageRecordProviderBreakdownSchema = z.object({
  provider: z.string(),
  credits: z.number(),
  usageKinds: z.array(
    z.object({
      kind: z.string(),
      credits: z.number(),
    }),
  ),
});

export const usageRecordKindBreakdownSchema = z.object({
  kind: usageRecordKindSchema,
  credits: z.number(),
  providers: z.array(usageRecordProviderBreakdownSchema),
});

export type UsageRecordKindBreakdown = z.infer<
  typeof usageRecordKindBreakdownSchema
>;

const usageRecordMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
});

// One usage row. Every run with a thread id aggregates into one row per
// user/thread, independent of trigger source. Historical usage without a
// recoverable thread id aggregates into one non-navigable fallback row.
const usageRecordRowSchema = z.object({
  // Old App -> new API rollout bridge for source-icon and run-link readers.
  // New consumers must not use these fields. Remove after the replacement App
  // is live and the client floor excludes those readers; tracked by #35077.
  source: usageRecordSourceSchema,
  // Set for navigable thread usage.
  threadId: z.string().nullable(),
  runId: z.string().nullable(),
  title: z.string().nullable(),
  credits: z.number(),
  tokens: z.number(),
  breakdown: z.array(usageRecordKindBreakdownSchema),
  member: usageRecordMemberSchema.nullable(),
  // ISO string of the most recent run in this row.
  lastActivityAt: z.string(),
});

const usageRecordResponseSchema = z.object({
  period: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  rows: z.array(usageRecordRowSchema),
  // Total credits across the whole range (not just the current page), so the
  // summary headline stays correct as more pages load in.
  totalCredits: z.number(),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});

export const usageRecordContract = c.router({
  get: {
    method: "GET",
    path: "/api/usage/record",
    headers: authHeadersSchema,
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().positive().max(100).default(20),
      scope: usageRecordScopeSchema.default("mine"),
      range: usageRecordRangeSchema.default("today"),
      tz: z.string().default("UTC"),
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
export type UsageRecordResponse = z.infer<typeof usageRecordResponseSchema>;
export type UsageRecordRow = z.infer<typeof usageRecordRowSchema>;
