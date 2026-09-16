import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const getStartedQuestKeySchema = z.enum([
  "connector",
  "slack",
  "workflow",
  "invite",
  "share",
  "checkin",
]);
export type GetStartedQuestKey = z.infer<typeof getStartedQuestKeySchema>;

export const getStartedClaimStatusSchema = z.enum([
  "pending",
  "reviewing",
  "granted",
  "rejected",
  "ineligible",
]);
export type GetStartedClaimStatus = z.infer<typeof getStartedClaimStatusSchema>;

export const GET_STARTED_REWARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GET_STARTED_REWARDS_CHANGED_EVENT = "getStartedRewardsChanged";
export const GET_STARTED_REWARDS = {
  connector: { amount: 100, limit: null, target: "user" },
  slack: { amount: 2000, limit: 1, target: "org" },
  workflow: { amount: 1000, limit: 1, target: "user" },
  invite: { amount: 100, limit: 15, target: "user" },
  share: { amount: 2000, limit: 1, target: "user" },
  checkin: { amount: 100, limit: null, target: "user" },
} as const;

export const getStartedClaimSchema = z.object({
  id: z.string().uuid(),
  questKey: getStartedQuestKeySchema,
  status: getStartedClaimStatusSchema,
  rewardAmount: z.number().int().nonnegative(),
  rewardTarget: z.enum(["user", "org"]),
  reason: z.string().nullable(),
  submittedAt: z.string().datetime(),
  grantedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type GetStartedClaim = z.infer<typeof getStartedClaimSchema>;

export const getStartedStatusSchema = z.object({
  serverNow: z.string().datetime(),
  nextResetAt: z.string().datetime(),
  claimedToday: z.boolean(),
  quests: z.array(
    z.object({
      key: getStartedQuestKeySchema,
      rewardAmount: z.number().int().positive(),
      rewardTarget: z.enum(["user", "org"]),
      claimedCount: z.number().int().nonnegative(),
      limit: z.number().int().positive().nullable(),
      earnedCredits: z.number().int().nonnegative(),
      canEarnMore: z.boolean(),
      pendingCount: z.number().int().nonnegative(),
    }),
  ),
  shareClaim: getStartedClaimSchema.nullable(),
  recentGrants: z.array(getStartedClaimSchema),
});
export type GetStartedStatus = z.infer<typeof getStartedStatusSchema>;

export const getStartedContract = c.router({
  status: {
    method: "GET",
    path: "/api/get-started",
    headers: authHeadersSchema,
    responses: {
      200: getStartedStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Read Get started rewards and redemption eligibility",
  },
  checkin: {
    method: "POST",
    path: "/api/get-started/check-in",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: getStartedClaimSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Claim the current UTC day's check-in bonus",
  },
  submitShare: {
    method: "POST",
    path: "/api/get-started/share",
    headers: authHeadersSchema,
    body: z.object({ url: z.string().max(2048) }),
    responses: {
      202: getStartedClaimSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Submit an X post for asynchronous reward verification",
  },
});

export const cronGetStartedContract = c.router({
  process: {
    method: "GET",
    path: "/api/cron/get-started-rewards",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ processed: z.number().int().nonnegative() }),
      401: apiErrorSchema,
    },
    summary: "Review pending Get started reward claims",
  },
});
