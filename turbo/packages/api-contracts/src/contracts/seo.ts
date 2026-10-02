import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SEO_DEFAULT_LOCATION = "United States" as const;
export const SEO_DEFAULT_LANGUAGE_CODE = "en" as const;
export const SEO_DEFAULT_SERP_LIMIT = 10;
export const SEO_DEFAULT_ANALYSIS_LIMIT = 100;
export const SEO_MAX_SERP_LIMIT = 100;
export const SEO_MAX_ANALYSIS_LIMIT = 100;
export const SEO_MAX_QUERY_CHARS = 512;
export const SEO_MAX_KEYWORD_CHARS = 512;
export const SEO_MAX_TARGET_CHARS = 2048;
export const SEO_MAX_LOCATION_CHARS = 256;

export const seoEngineSchema = z.enum([
  "google",
  "bing",
  "google_maps",
  "google_news",
]);

export const seoDeviceSchema = z.enum(["desktop", "mobile"]);

export const seoLanguageCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i, "language must be a language code");

const seoLocationSchema = z.string().trim().min(1).max(SEO_MAX_LOCATION_CHARS);

const seoDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => {
    return (
      !value.includes("://") &&
      !value.includes("/") &&
      !value.includes("?") &&
      !value.includes("#") &&
      value.includes(".")
    );
  }, "target must be a domain without a protocol or path");

export const seoSerpRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(SEO_MAX_QUERY_CHARS),
    provider: z.literal("dataforseo").default("dataforseo"),
    engine: seoEngineSchema.default("google"),
    location: seoLocationSchema.default(SEO_DEFAULT_LOCATION),
    languageCode: seoLanguageCodeSchema.default(SEO_DEFAULT_LANGUAGE_CODE),
    device: seoDeviceSchema.default("desktop"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEO_MAX_SERP_LIMIT)
      .default(SEO_DEFAULT_SERP_LIMIT),
  })
  .superRefine((value, context) => {
    if (value.engine === "google_news" && value.device === "mobile") {
      context.addIssue({
        code: "custom",
        path: ["device"],
        message: "DataForSEO Google News supports only the desktop device",
      });
    }
  });

export const seoKeywordIdeasRequestSchema = z.object({
  keyword: z.string().trim().min(3).max(SEO_MAX_KEYWORD_CHARS),
  location: seoLocationSchema.default(SEO_DEFAULT_LOCATION),
  languageCode: seoLanguageCodeSchema.default(SEO_DEFAULT_LANGUAGE_CODE),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEO_MAX_ANALYSIS_LIMIT)
    .default(SEO_DEFAULT_ANALYSIS_LIMIT),
});

export const seoRankedKeywordsRequestSchema = z.object({
  target: seoDomainSchema,
  location: seoLocationSchema.default(SEO_DEFAULT_LOCATION),
  languageCode: seoLanguageCodeSchema.default(SEO_DEFAULT_LANGUAGE_CODE),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEO_MAX_ANALYSIS_LIMIT)
    .default(SEO_DEFAULT_ANALYSIS_LIMIT),
});

export const seoBacklinksSummaryRequestSchema = z.object({
  target: z.string().trim().min(1).max(SEO_MAX_TARGET_CHARS),
  includeSubdomains: z.boolean().default(true),
});

export const seoOperationSchema = z.enum([
  "serp",
  "keyword-ideas",
  "ranked-keywords",
  "backlinks-summary",
]);

const seoResponseBaseSchema = z.object({
  operation: seoOperationSchema,
  creditsCharged: z.number().int().nonnegative().nullable(),
  result: z.unknown(),
});

export const seoResponseSchema = seoResponseBaseSchema.extend({
  provider: z.literal("dataforseo"),
  billingCategory: z.literal("provider_cost_usd_micros"),
  billingQuantity: z.number().int().nonnegative(),
  providerCostUsd: z.number().nonnegative(),
});

export type SeoEngine = z.infer<typeof seoEngineSchema>;
export type SeoDevice = z.infer<typeof seoDeviceSchema>;
export type SeoSerpRequest = z.infer<typeof seoSerpRequestSchema>;
export type SeoKeywordIdeasRequest = z.infer<
  typeof seoKeywordIdeasRequestSchema
>;
export type SeoRankedKeywordsRequest = z.infer<
  typeof seoRankedKeywordsRequestSchema
>;
export type SeoBacklinksSummaryRequest = z.infer<
  typeof seoBacklinksSummaryRequestSchema
>;
export type SeoOperation = z.infer<typeof seoOperationSchema>;
export type SeoResponse = z.infer<typeof seoResponseSchema>;

const seoResponses = {
  200: seoResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const seoContract = c.router({
  serp: {
    method: "POST",
    path: "/api/seo/serp",
    headers: authHeadersSchema,
    body: seoSerpRequestSchema,
    responses: seoResponses,
    summary: "Fetch live search engine results through managed Okou SEO",
  },
  keywordIdeas: {
    method: "POST",
    path: "/api/seo/keyword-ideas",
    headers: authHeadersSchema,
    body: seoKeywordIdeasRequestSchema,
    responses: seoResponses,
    summary: "Find related keyword ideas through managed Okou SEO",
  },
  rankedKeywords: {
    method: "POST",
    path: "/api/seo/ranked-keywords",
    headers: authHeadersSchema,
    body: seoRankedKeywordsRequestSchema,
    responses: seoResponses,
    summary: "List ranked keywords for a domain through managed Okou SEO",
  },
  backlinksSummary: {
    method: "POST",
    path: "/api/seo/backlinks-summary",
    headers: authHeadersSchema,
    body: seoBacklinksSummaryRequestSchema,
    responses: seoResponses,
    summary: "Fetch a backlink summary through managed Okou SEO",
  },
});

export type SeoContract = typeof seoContract;
