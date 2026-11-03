import {
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export { FRIEND_REFERRAL_REWARD_CREDITS } from "../validators/friend-referrals";

export const friendReferralStatusSchema = object({
  code: uuid(),
  registeredCount: number().int().nonnegative(),
  rewardedCount: number().int().nonnegative(),
  earnedCredits: number().int().nonnegative(),
});
export type FriendReferralStatus = zInfer<typeof friendReferralStatusSchema>;

export const friendReferralsContract = c.router({
  link: {
    method: "POST",
    path: "/api/friend-referrals/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: friendReferralStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Create or read your personal friend referral link and progress",
  },
  visit: {
    method: "POST",
    path: "/api/friend-referrals/visit",
    body: object({ code: uuid() }),
    responses: { 200: object({ token: string() }), 404: apiErrorSchema },
    summary: "Record a referral visit before a friend registers",
  },
  register: {
    method: "POST",
    path: "/api/friend-referrals/register",
    headers: authHeadersSchema,
    body: object({ token: string().max(512) }),
    responses: {
      200: object({ status: zEnum(["registered", "ineligible"]) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Bind a new registration to its original friend referral",
  },
});
