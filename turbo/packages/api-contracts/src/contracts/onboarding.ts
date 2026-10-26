import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { publicConnectorCatalogConnectListResponseSchema } from "./connector-catalog";
import { userLocaleSchema } from "./user-preferences";

const c = initContract();

/**
 * Onboarding status response schema
 */
export const onboardingStatusResponseSchema = object({
  needsOnboarding: boolean(),
  onboardingComplete: boolean(),
  isAdmin: boolean(),
  hasOrg: boolean(),
  hasDefaultAgent: boolean(),
  defaultAgentId: string().nullable(),
  defaultAgentMetadata: object({
    displayName: string().optional(),
    description: string().optional(),
    sound: string().optional(),
    avatarUrl: string().optional(),
  }).nullable(),
});

export type OnboardingStatusResponse = zInfer<
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

export const onboardingIndustrySchema = zEnum(ONBOARDING_INDUSTRY_IDS);

export type OnboardingIndustry = zInfer<typeof onboardingIndustrySchema>;

export const onboardingSubscriptionProviderSchema = zEnum([
  "codex",
  "claudeCode",
]);

export type OnboardingSubscriptionProvider = zInfer<
  typeof onboardingSubscriptionProviderSchema
>;

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

export const onboardingRecommendationConnectorSlugSchema = zEnum(
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
);

export type OnboardingRecommendationConnectorSlug = zInfer<
  typeof onboardingRecommendationConnectorSlugSchema
>;

/** A short, evidence-based portrait from the same sources as the first task. */
export const onboardingUserProfileSchema = object({
  overview: string().trim().min(1).max(240),
  professionalIdentity: array(string().trim().min(1).max(180)).max(3),
  communicationStyle: array(string().trim().min(1).max(180)).max(3),
  priorities: array(string().trim().min(1).max(180)).max(3),
}).strict();

export type OnboardingUserProfile = zInfer<typeof onboardingUserProfileSchema>;

export const onboardingRecommendationSchema = object({
  kind: zEnum(["task", "workflow"]),
  title: string().trim().min(1).max(120),
  outcome: string().trim().min(1).max(240),
  prompt: string().trim().min(1).max(1000),
  profile: onboardingUserProfileSchema,
}).strict();

export type OnboardingRecommendation = zInfer<
  typeof onboardingRecommendationSchema
>;

const onboardingRecommendationJobSchema = object({
  jobId: uuid(),
});

export const onboardingRecommendationStatusSchema = discriminatedUnion(
  "status",
  [
    onboardingRecommendationJobSchema.extend({
      status: zEnum(["pending", "running"]),
    }),
    onboardingRecommendationJobSchema.extend({
      status: literal("completed"),
      recommendation: onboardingRecommendationSchema,
    }),
    onboardingRecommendationJobSchema.extend({
      status: literal("failed"),
    }),
  ],
);

export type OnboardingRecommendationStatus = zInfer<
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

/**
 * The onboarding sources, `ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS`, each with
 * what its card draws and what connecting it from one click needs.
 */
export const onboardingSourcesContract = c.router({
  list: {
    method: "GET",
    path: "/api/onboarding/sources",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogConnectListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List onboarding source connectors with connection status",
  },
});

export const onboardingCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/onboarding/complete",
    headers: authHeadersSchema,
    body: object({
      // Semantic IANA validation happens after core completion so an invalid
      // optional fallback cannot roll back the onboarding transition.
      timezone: string().optional(),
      // The field answered in the source-first flow. Only that flow asks the
      // question, so an absent industry completes onboarding unchanged.
      industry: onboardingIndustrySchema.optional(),
    }).strict(),
    responses: {
      200: object({
        onboardingComplete: literal(true),
        needsOnboarding: literal(false),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary:
      "Mark onboarding complete: for the org when an admin finishes it, for the member alone otherwise",
  },
});

export const onboardingRecommendationContract = c.router({
  start: {
    method: "POST",
    path: "/api/onboarding/recommendations",
    headers: authHeadersSchema,
    body: object({
      industry: onboardingIndustrySchema,
      locale: onboardingRecommendationLocaleSchema,
    }).strict(),
    responses: {
      202: onboardingRecommendationJobSchema.extend({
        status: literal("pending"),
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
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a context-aware onboarding recommendation",
  },
});

export type OnboardingStatusContract = typeof onboardingStatusContract;
export type OnboardingCompleteContract = typeof onboardingCompleteContract;
export type OnboardingRecommendationContract =
  typeof onboardingRecommendationContract;
