import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { impactAttributionSchema } from "./impact-attribution";

const c = initContract();

// Canonical acquisition source-type taxonomy. Single source of truth shared by
// the web classifier (apps/web), the app capture layer (apps/platform), and the
// signup contract below, so the enum can't drift across the three.
export const SOURCE_TYPES = [
  "paid",
  "organic_search",
  "referral",
  "direct",
  "internal",
  "unknown",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

// First-party, root-domain (.okou.ai) cookie carrying first-touch acquisition
// attribution across the www.okou.ai -> app.okou.ai subdomain hop. Written by the
// marketing site (consent-gated), read by the app on first load.
export const ACQUISITION_ATTRIBUTION_COOKIE = "vm0_attribution";

export const adAttributionMetadataSchema = z
  .object({
    source_type: z.enum(SOURCE_TYPES).optional(),
    referrer_domain: z.string().min(1).max(253).optional(),
    landing_host: z.string().min(1).max(253).optional(),
    landing_path: z.string().min(1).max(500).optional(),
    vm0_source: z.string().min(1).max(100).optional(),
    utm_source: z.string().min(1).max(100).optional(),
    utm_medium: z.string().min(1).max(100).optional(),
    utm_campaign: z.string().min(1).max(200).optional(),
    // Google Ads ValueTrack IDs are the stable join keys for campaign and ad
    // group reporting. Names and UTM values can change independently.
    okou_campaign_id: z.string().min(1).max(100).optional(),
    okou_ad_group_id: z.string().min(1).max(100).optional(),
    // Old App requests and persisted first-touch records remain valid (#33059).
    vm0_campaign_id: z.string().min(1).max(100).optional(),
    vm0_ad_group_id: z.string().min(1).max(100).optional(),
    utm_content: z.string().min(1).max(200).optional(),
    utm_term: z.string().min(1).max(200).optional(),
    vm0_experiment: z.string().min(1).max(100).optional(),
    vm0_variant: z.string().min(1).max(100).optional(),
    lp_variant: z.string().min(1).max(100).optional(),
    gclid: z.string().min(1).max(200).optional(),
    gbraid: z.string().min(1).max(200).optional(),
    wbraid: z.string().min(1).max(200).optional(),
    // GA4's browser client ID is read from the first-party _ga cookie. It is
    // carried separately from ad click IDs so server-side GA4 events can be
    // joined back to the browser session without treating every visitor as a
    // Google Ads conversion.
    ga_client_id: z.string().min(1).max(100).optional(),
    gclid_present: z.literal("true").optional(),
    gbraid_present: z.literal("true").optional(),
    wbraid_present: z.literal("true").optional(),
  })
  .strict();

const recordSignupAttributionRequestSchema = z.object({
  attribution: adAttributionMetadataSchema,
  // A sibling field keeps old strict first-touch readers compatible.
  impactAttribution: impactAttributionSchema.optional(),
});

const recordSignupAttributionResponseSchema = z.object({
  recorded: z.boolean(),
  googleAdsAccountId: z.string().nullable(),
});

export const GOOGLE_ADS_CONVERSION_MILESTONE_KINDS = [
  "free_trial_completed",
  "first_run_completed",
  "second_run_completed",
  "multi_day_run_completed",
  "one_connector_connected",
  "two_connectors_connected",
] as const;

const googleAdsConversionMilestoneSchema = z.object({
  kind: z.enum(GOOGLE_ADS_CONVERSION_MILESTONE_KINDS),
  transactionId: z.string().min(1),
});

const googleAdsConversionMilestonesResponseSchema = z.object({
  milestones: z.array(googleAdsConversionMilestoneSchema),
  googleAdsAccountId: z.string().nullable(),
});

export const acquisitionAttributionContract = c.router({
  resolveGoogleAdsAccount: {
    method: "POST",
    path: "/api/attribution/google-ads-account",
    headers: authHeadersSchema,
    body: z.object({ attribution: adAttributionMetadataSchema.optional() }),
    responses: {
      200: z.object({ googleAdsAccountId: z.string().nullable() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Resolve the Google Ads account from authoritative first-touch attribution",
  },
  googleAdsMilestones: {
    method: "GET",
    path: "/api/attribution/google-ads-milestones",
    headers: authHeadersSchema,
    responses: {
      200: googleAdsConversionMilestonesResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Get server-confirmed Google Ads conversion milestones for the current user",
  },
  recordSignup: {
    method: "POST",
    path: "/api/attribution/signup",
    headers: authHeadersSchema,
    body: recordSignupAttributionRequestSchema,
    responses: {
      200: recordSignupAttributionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Record first-touch signup attribution on the current user",
  },
});

export type AdAttributionMetadata = z.infer<typeof adAttributionMetadataSchema>;
export type RecordSignupAttributionRequest = z.infer<
  typeof recordSignupAttributionRequestSchema
>;
export type RecordSignupAttributionResponse = z.infer<
  typeof recordSignupAttributionResponseSchema
>;
export type GoogleAdsConversionMilestoneKind =
  (typeof GOOGLE_ADS_CONVERSION_MILESTONE_KINDS)[number];
export type GoogleAdsConversionMilestone = z.infer<
  typeof googleAdsConversionMilestoneSchema
>;
export type GoogleAdsConversionMilestonesResponse = z.infer<
  typeof googleAdsConversionMilestonesResponseSchema
>;
export type AcquisitionAttributionContract =
  typeof acquisitionAttributionContract;
