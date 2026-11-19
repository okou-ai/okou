import {
  boolean,
  enum as zEnum,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { userLocaleSchema } from "./user-preferences";

/**
 * The fields the source-first onboarding flow offers as its first question.
 *
 * The list lives here so the completion body validates against exactly what
 * the screens offer. `@okouai/core/onboarding-industry` re-exports it for the
 * browser, because that package depends on this one and not the other way
 * round.
 */
export const ONBOARDING_INDUSTRY_IDS = [
  "marketing",
  "design",
  "consulting",
  "coaching",
  "finance",
  "operations",
  "sales",
  "software",
  "research",
  "investing",
  "other",
] as const;

export const onboardingIndustrySchema = zEnum(ONBOARDING_INDUSTRY_IDS);

export const onboardingSubscriptionProviderSchema = zEnum([
  "codex",
  "claudeCode",
]);

export const onboardingRecommendationLocaleSchema = userLocaleSchema;

/**
 * Sources whose account context can shape the source-first onboarding result.
 *
 * This deliberately follows the curated onboarding surface, not the complete
 * connector catalog. Keeping the list beside the API contract gives Platform
 * and the collector registry one exhaustive boundary.
 */
export const ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS = [
  "gmail",
  "google-docs",
  "google-drive",
  "google-sheets",
  "github",
  "quickbooks",
  "hubspot",
  "linear",
  "notion",
  "google-calendar",
  "outlook-mail",
  "google-ads",
  "meta-ads",
] as const;

export const onboardingDraftStepSchema = zEnum([
  "industry",
  "sources",
  "experience",
  "skills",
  "slack",
  "capabilities",
  "ready",
]);

export const ONBOARDING_STARTING_PROMPT_MAX_LENGTH = 1000;

export const onboardingStartingPromptFormatSchema = zEnum([
  "image",
  "presentation",
  "website",
  "report",
  "research",
  "people",
]);

export const onboardingStartingPromptOutputSchema = object({
  format: onboardingStartingPromptFormatSchema,
  start: number().int().min(0).max(ONBOARDING_STARTING_PROMPT_MAX_LENGTH),
  end: number().int().min(0).max(ONBOARDING_STARTING_PROMPT_MAX_LENGTH),
});

export const onboardingDraftAnswersSchema = object({
  industry: onboardingIndustrySchema.nullable(),
  experienced: boolean().nullable(),
  provider: onboardingSubscriptionProviderSchema.nullable(),
  startingPromptDraft: string().max(ONBOARDING_STARTING_PROMPT_MAX_LENGTH),
  startingPromptKey: string().max(512),
  startingPromptOutput: onboardingStartingPromptOutputSchema
    .nullable()
    .default(null),
  recommendationJobId: uuid().nullable(),
  recommendationStartedAt: number().finite().nonnegative().nullable(),
});

export const onboardingDraftPayloadSchema = object({
  answers: onboardingDraftAnswersSchema,
  step: onboardingDraftStepSchema.nullable(),
}).strict();

export type OnboardingDraftPayload = zInfer<
  typeof onboardingDraftPayloadSchema
>;
