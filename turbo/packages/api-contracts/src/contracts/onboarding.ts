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

export const onboardingRecommendationLocaleSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u);

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

export const onboardingRecommendationConnectorSlugSchema = z.enum(
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
);

export type OnboardingRecommendationConnectorSlug = z.infer<
  typeof onboardingRecommendationConnectorSlugSchema
>;

export const onboardingRecommendationSchema = z
  .object({
    kind: z.enum(["task", "workflow"]),
    title: z.string().min(1).max(120),
    outcome: z.string().min(1).max(240),
    prompt: z.string().min(1).max(1000),
  })
  .strict();

export type OnboardingRecommendation = z.infer<
  typeof onboardingRecommendationSchema
>;

const onboardingRecommendationJobSchema = z.object({
  jobId: z.uuid(),
});

export const onboardingRecommendationStatusSchema = z.discriminatedUnion(
  "status",
  [
    onboardingRecommendationJobSchema.extend({
      status: z.enum(["pending", "running"]),
    }),
    onboardingRecommendationJobSchema.extend({
      status: z.literal("completed"),
      recommendation: onboardingRecommendationSchema,
    }),
    onboardingRecommendationJobSchema.extend({
      status: z.literal("failed"),
    }),
  ],
);

export type OnboardingRecommendationStatus = z.infer<
  typeof onboardingRecommendationStatusSchema
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

export const onboardingRecommendationContract = c.router({
  start: {
    method: "POST",
    path: "/api/onboarding/recommendations",
    headers: authHeadersSchema,
    body: z
      .object({
        industry: onboardingIndustrySchema,
        locale: onboardingRecommendationLocaleSchema,
      })
      .strict(),
    responses: {
      202: onboardingRecommendationJobSchema.extend({
        status: z.literal("pending"),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Start a context-aware onboarding recommendation",
  },
  get: {
    method: "GET",
    path: "/api/onboarding/recommendations/:jobId",
    headers: authHeadersSchema,
    pathParams: onboardingRecommendationJobSchema,
    responses: {
      200: onboardingRecommendationStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a context-aware onboarding recommendation",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
export type OnboardingCompleteContract = typeof onboardingCompleteContract;
export type OnboardingRecommendationContract =
  typeof onboardingRecommendationContract;
