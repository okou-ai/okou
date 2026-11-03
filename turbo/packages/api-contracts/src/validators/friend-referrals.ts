import { string } from "zod";

export const friendReferralCodeSchema = string().regex(/^[a-z0-9]{6}$/u);

export const FRIEND_REFERRAL_REWARD_CREDITS = 20_000;
