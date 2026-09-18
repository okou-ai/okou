import { z } from "zod";

// Acquisition properties retained for App PostHog events and historical
// migration tooling. Runtime attribution persistence belongs to Marketing.
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

export type AdAttributionMetadata = z.infer<typeof adAttributionMetadataSchema>;
