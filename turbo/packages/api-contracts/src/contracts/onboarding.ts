import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Onboarding status response schema
 */
export const onboardingStatusResponseSchema = z.object({
  needsOnboarding: z.boolean(),
  onboardingComplete: z.boolean(),
  isAdmin: z.boolean(),
  hasOrg: z.boolean(),
  hasDefaultAgent: z.boolean(),
  defaultAgentId: z.string().nullable(),
  defaultAgentMetadata: z
    .object({
      displayName: z.string().optional(),
      description: z.string().optional(),
      sound: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .nullable(),
});

export type OnboardingStatusResponse = z.infer<
  typeof onboardingStatusResponseSchema
>;

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

export const onboardingIndustrySchema = z.enum(ONBOARDING_INDUSTRY_IDS);

export type OnboardingIndustry = z.infer<typeof onboardingIndustrySchema>;

export const onboardingSubscriptionProviderSchema = z.enum([
  "codex",
  "claudeCode",
]);

export type OnboardingSubscriptionProvider = z.infer<
  typeof onboardingSubscriptionProviderSchema
>;

/**
 * Onboarding status contract for GET /api/onboarding/status
 */
export const onboardingStatusContract = c.router({
  getStatus: {
    method: "GET",
    path: "/api/onboarding/status",
    headers: authHeadersSchema,
    responses: {
      200: onboardingStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Get onboarding status for current user",
  },
});

export const onboardingCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/onboarding/complete",
    headers: authHeadersSchema,
    // A query field keeps older API deployments able to complete onboarding:
    // they ignore this optional preference and retain the existing model seed.
    query: z
      .object({
        modelProvider: onboardingSubscriptionProviderSchema.optional(),
      })
      .optional(),
    body: z
      .object({
        // Semantic IANA validation happens after core completion so an invalid
        // optional fallback cannot roll back the onboarding transition.
        timezone: z.string().optional(),
        // The field answered in the source-first flow. Only that flow asks the
        // question, so an absent industry completes onboarding unchanged.
        industry: onboardingIndustrySchema.optional(),
      })
      .strict(),
    responses: {
      200: z.object({
        onboardingComplete: z.literal(true),
        needsOnboarding: z.literal(false),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Mark onboarding complete for the current org",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
export type OnboardingCompleteContract = typeof onboardingCompleteContract;
