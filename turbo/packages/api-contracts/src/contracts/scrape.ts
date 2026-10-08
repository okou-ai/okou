import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const scrapeFormatSchema = z.enum(["markdown", "links"]);
export const scrapeModeSchema = z.enum(["standard", "enhanced"]);
export const scrapeBillingCategorySchema = z.enum([
  "standard.markdown",
  "standard.links",
  "enhanced.markdown",
  "enhanced.links",
]);

export const scrapeRequestSchema = z.object({
  url: z.string().trim().url().max(2_048),
  format: scrapeFormatSchema.default("markdown"),
  mode: scrapeModeSchema.default("standard"),
});

export const scrapeMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  statusCode: z.number().int().optional(),
  publishedTime: z.string().optional(),
});

const scrapeResponseBaseSchema = z.object({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url().optional(),
  provider: z.literal("firecrawl"),
  creditsCharged: z.number().int().nonnegative().nullable(),
  billingQuantity: z.number().int().positive(),
  metadata: scrapeMetadataSchema.optional(),
});

const scrapeMarkdownResultSchema = z.object({
  markdown: z.string(),
});

const scrapeLinksResultSchema = z.object({
  links: z.array(z.string()),
});

const scrapeStandardMarkdownResponseSchema = scrapeResponseBaseSchema.extend({
  format: z.literal("markdown"),
  mode: z.literal("standard"),
  billingCategory: z.literal("standard.markdown"),
  result: scrapeMarkdownResultSchema,
});

const scrapeEnhancedMarkdownResponseSchema = scrapeResponseBaseSchema.extend({
  format: z.literal("markdown"),
  mode: z.literal("enhanced"),
  billingCategory: z.literal("enhanced.markdown"),
  result: scrapeMarkdownResultSchema,
});

const scrapeStandardLinksResponseSchema = scrapeResponseBaseSchema.extend({
  format: z.literal("links"),
  mode: z.literal("standard"),
  billingCategory: z.literal("standard.links"),
  result: scrapeLinksResultSchema,
});

const scrapeEnhancedLinksResponseSchema = scrapeResponseBaseSchema.extend({
  format: z.literal("links"),
  mode: z.literal("enhanced"),
  billingCategory: z.literal("enhanced.links"),
  result: scrapeLinksResultSchema,
});

export const scrapeMarkdownResponseSchema = z.union([
  scrapeStandardMarkdownResponseSchema,
  scrapeEnhancedMarkdownResponseSchema,
]);

export const scrapeLinksResponseSchema = z.union([
  scrapeStandardLinksResponseSchema,
  scrapeEnhancedLinksResponseSchema,
]);

export const scrapeResponseSchema = z.union([
  scrapeMarkdownResponseSchema,
  scrapeLinksResponseSchema,
]);

export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
export type ScrapeResponse = z.infer<typeof scrapeResponseSchema>;
export type ScrapeFormat = z.infer<typeof scrapeFormatSchema>;
export type ScrapeMode = z.infer<typeof scrapeModeSchema>;
export type ScrapeBillingCategory = z.infer<typeof scrapeBillingCategorySchema>;

const scrapeResponses = {
  200: scrapeResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const scrapeContract = c.router({
  scrape: {
    method: "POST",
    path: "/api/scrape",
    headers: authHeadersSchema,
    body: scrapeRequestSchema,
    responses: scrapeResponses,
    summary: "Scrape a public web page through Okou-managed scraping",
  },
});

export type ScrapeContract = typeof scrapeContract;
