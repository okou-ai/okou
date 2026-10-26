import { array, number, object, string, type infer as zInfer } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  usageRecordKindBreakdownSchema,
  usageRecordRangeSchema,
} from "./usage-record";

const c = initContract();

const memberUsageSchema = object({
  userId: string(),
  email: string(),
  inputTokens: number(),
  outputTokens: number(),
  cacheReadInputTokens: number(),
  cacheCreationInputTokens: number(),
  creditsCharged: number(),
  breakdown: array(usageRecordKindBreakdownSchema),
});

const usageMembersResponseSchema = object({
  period: object({
    start: string(),
    end: string(),
  }).nullable(),
  members: array(memberUsageSchema),
});

/**
 * Usage contract for GET /api/usage/members
 */
export const usageMembersContract = c.router({
  get: {
    method: "GET",
    path: "/api/usage/members",
    headers: authHeadersSchema,
    query: object({
      range: usageRecordRangeSchema.default("billingPeriod"),
      tz: string().default("UTC"),
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
export type MemberUsage = zInfer<typeof memberUsageSchema>;
export type UsageMembersResponse = zInfer<typeof usageMembersResponseSchema>;
