import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { usageRecordRangeSchema } from "./usage-record";

const c = initContract();

const memberUsageSchema = z.object({
  userId: z.string(),
  email: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  creditsCharged: z.number(),
});

const usageMembersResponseSchema = z.object({
  period: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .nullable(),
  members: z.array(memberUsageSchema),
});

/**
 * Usage contract for GET /api/usage/members
 */
export const usageMembersContract = c.router({
  get: {
    method: "GET",
    path: "/api/usage/members",
    headers: authHeadersSchema,
    query: z.object({
      range: usageRecordRangeSchema.default("billingPeriod"),
      tz: z.string().default("UTC"),
    }),
    responses: {
      200: usageMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get per-member usage for a selected period",
  },
});

export type UsageMembersContract = typeof usageMembersContract;

// Inferred types from Zod schemas
export type MemberUsage = z.infer<typeof memberUsageSchema>;
export type UsageMembersResponse = z.infer<typeof usageMembersResponseSchema>;
