import {
  array,
  boolean,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const getStartedQuestKeySchema = zEnum([
  "connector",
  "slack",
  "imessage",
  "workflow",
  "invite",
  "share",
  "checkin",
]);
export type GetStartedQuestKey = zInfer<typeof getStartedQuestKeySchema>;

export const getStartedClaimStatusSchema = zEnum([
  "pending",
  "reviewing",
  "granted",
  "rejected",
  "ineligible",
]);
export type GetStartedClaimStatus = zInfer<typeof getStartedClaimStatusSchema>;

export const GET_STARTED_REWARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GET_STARTED_REWARDS_CHANGED_EVENT = "getStartedRewardsChanged";
export const GET_STARTED_REWARDS = {
  connector: { amount: 100, limit: null, target: "user" },
  slack: { amount: 2000, limit: 1, target: "org" },
  imessage: { amount: 1000, limit: 1, target: "user" },
  workflow: { amount: 1000, limit: 1, target: "user" },
  invite: { amount: 100, limit: 15, target: "user" },
  share: { amount: 2000, limit: 1, target: "user" },
  checkin: { amount: 100, limit: null, target: "user" },
} as const;

export const getStartedClaimSchema = object({
  id: string().uuid(),
  questKey: getStartedQuestKeySchema,
  status: getStartedClaimStatusSchema,
  rewardAmount: number().int().nonnegative(),
  rewardTarget: zEnum(["user", "org"]),
  reason: string().nullable(),
  /**
   * The post the claim was opened with, for the quests that submit one.
   *
   * Only the share quest carries a URL, and the row has always stored it; the
   * status response simply never returned it, so a user waiting on review had
   * no way to see which post was in the queue. Nullable for the quests that
   * submit nothing, and for a claim read back by a client newer than the API
   * that fills it in.
   */
  postUrl: string().nullable(),
  submittedAt: string().datetime(),
  grantedAt: string().datetime().nullable(),
  expiresAt: string().datetime().nullable(),
});
export type GetStartedClaim = zInfer<typeof getStartedClaimSchema>;

export const getStartedStatusSchema = object({
  serverNow: string().datetime(),
  nextResetAt: string().datetime(),
  claimedToday: boolean(),
  /** Consecutive UTC days the user has checked in, counting back from today. */
  checkinStreak: number().int().nonnegative(),
  quests: array(
    object({
      key: getStartedQuestKeySchema,
      rewardAmount: number().int().positive(),
      rewardTarget: zEnum(["user", "org"]),
      claimedCount: number().int().nonnegative(),
      limit: number().int().positive().nullable(),
      earnedCredits: number().int().nonnegative(),
      canEarnMore: boolean(),
      pendingCount: number().int().nonnegative(),
    }),
  ),
  shareClaim: getStartedClaimSchema.nullable(),
  recentGrants: array(getStartedClaimSchema),
});
export type GetStartedStatus = zInfer<typeof getStartedStatusSchema>;

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
    body: object({ url: string().max(2048) }),
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
      200: object({ processed: number().int().nonnegative() }),
      401: apiErrorSchema,
    },
    summary: "Review pending Get started reward claims",
  },
});
