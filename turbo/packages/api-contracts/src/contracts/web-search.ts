import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_LIMIT = 10;
export const WEB_SEARCH_MAX_QUERY_CHARS = 2_048;
export const WEB_SEARCH_MAX_DOMAINS = 20;
export const WEB_SEARCH_MAX_DOMAIN_CHARS = 253;
export const WEB_SEARCH_MAX_TITLE_CHARS = 512;
export const WEB_SEARCH_MAX_URL_CHARS = 2_048;
export const WEB_SEARCH_MAX_SNIPPET_CHARS = 8_000;
export const WEB_SEARCH_MAX_DATE_CHARS = 64;

const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isDomain(value: string): boolean {
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => {
      return domainLabelPattern.test(label);
    })
  );
}

export const webSearchRecencySchema = z.enum([
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

export const webSearchDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(WEB_SEARCH_MAX_DOMAIN_CHARS)
  .refine(isDomain, {
    message: "Domain must be a domain or subdomain without a protocol or path",
  })
  .transform((domain) => {
    return domain.toLowerCase();
  });

const webSearchDomainsSchema = z
  .array(webSearchDomainSchema)
  .max(WEB_SEARCH_MAX_DOMAINS)
  .transform((domains) => {
    return [...new Set(domains)];
  });

export const webSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(WEB_SEARCH_MAX_QUERY_CHARS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WEB_SEARCH_MAX_LIMIT)
    .default(WEB_SEARCH_DEFAULT_LIMIT),
  recency: webSearchRecencySchema.optional(),
  domains: webSearchDomainsSchema.optional(),
});

const webSearchHttpUrlSchema = z
  .string()
  .max(WEB_SEARCH_MAX_URL_CHARS)
  .url()
  .regex(/^https?:\/\//i, "Result URL must use http or https");

export const webSearchResultSchema = z.object({
  rank: z.number().int().min(1).max(WEB_SEARCH_MAX_LIMIT),
  title: z.string().max(WEB_SEARCH_MAX_TITLE_CHARS),
  url: webSearchHttpUrlSchema,
  snippet: z.string().max(WEB_SEARCH_MAX_SNIPPET_CHARS),
  publishedDate: z.string().max(WEB_SEARCH_MAX_DATE_CHARS).optional(),
  lastUpdatedDate: z.string().max(WEB_SEARCH_MAX_DATE_CHARS).optional(),
});

export const webSearchResponseSchema = z.object({
  query: z.string().max(WEB_SEARCH_MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(WEB_SEARCH_MAX_LIMIT),
  recency: webSearchRecencySchema.optional(),
  domains: z
    .array(webSearchDomainSchema)
    .max(WEB_SEARCH_MAX_DOMAINS)
    .optional(),
  provider: z.literal("perplexity"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative().nullable(),
  results: z.array(webSearchResultSchema).max(WEB_SEARCH_MAX_LIMIT),
});

export type WebSearchRecency = z.infer<typeof webSearchRecencySchema>;
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;
export type WebSearchResponse = z.infer<typeof webSearchResponseSchema>;

const webSearchResponses = {
  200: webSearchResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const webSearchContract = c.router({
  search: {
    method: "POST",
    path: "/api/web-search",
    headers: authHeadersSchema,
    body: webSearchRequestSchema,
    responses: webSearchResponses,
    summary: "Search the public web through managed Okou web search",
  },
});

export type WebSearchContract = typeof webSearchContract;
