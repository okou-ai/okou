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
export { GET_STARTED_REWARDS_CHANGED_EVENT } from "../validators/get-started";

const c = initContract();

export const getStartedQuestKeySchema = zEnum([
  "connector",
  "slack",
  "imessage",
  "workflow",
  "invite",
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
export const GET_STARTED_REWARDS = {
  connector: { amount: 100, limit: null, target: "user" },
  slack: { amount: 2000, limit: 1, target: "org" },
  imessage: { amount: 1000, limit: 1, target: "user" },
  workflow: { amount: 1000, limit: 1, target: "user" },
  invite: { amount: 100, limit: 15, target: "user" },
  checkin: { amount: 100, limit: null, target: "user" },
} as const;

export const getStartedClaimSchema = object({
  id: string().uuid(),
  questKey: getStartedQuestKeySchema,
  status: getStartedClaimStatusSchema,
  rewardAmount: number().int().nonnegative(),
  rewardTarget: zEnum(["user", "org"]),
  reason: string().nullable(),
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
