import { literal, union, type ZodType } from "zod";

export const USAGE_PACKS_USD = [20, 50, 100, 200] as const;
export type UsagePackUsd = (typeof USAGE_PACKS_USD)[number];

export const usagePackUsdSchema: ZodType<UsagePackUsd> = union([
  literal(20),
  literal(50),
  literal(100),
  literal(200),
]);

// One-question billing surveys. Platform reads these lists to render the
// answers, so they live outside the route-bearing contract module.
export const CREDITS_EXHAUSTED_SURVEY_ANSWERS = [
  "too_expensive",
  "not_sure_worth_it",
  "still_trying",
  "no_need_now",
  "other",
] as const;

export const CHECKOUT_ABANDONED_SURVEY_ANSWERS = [
  "price_higher_than_expected",
  "not_seeing_value",
  "results_not_good_enough",
  "not_ready_yet",
  "payment_issue",
  "needs_approval",
  "just_checking_price",
  "other",
] as const;

export const BILLING_SURVEY_CHECKOUT_KINDS = [
  "plan",
  "usage_pack",
  "credits",
] as const;
