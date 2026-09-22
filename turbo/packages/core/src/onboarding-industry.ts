/**
 * The field the source-first onboarding flow asks for first.
 *
 * The values are declared in `@okouai/api-contracts` so the completion body
 * validates against them directly, and re-exported here so the onboarding
 * screens and the contract share one list instead of keeping two that drift.
 */

export {
  ONBOARDING_INDUSTRY_IDS,
  type OnboardingIndustry,
} from "@okouai/api-contracts/contracts/onboarding";
