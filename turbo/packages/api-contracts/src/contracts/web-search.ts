import { z } from "zod";

export const WEB_SEARCH_DEFAULT_LIMIT = 5;

export const WEB_SEARCH_MAX_LIMIT = 10;

export const WEB_SEARCH_MAX_QUERY_CHARS = 2_048;

export const WEB_SEARCH_MAX_DOMAINS = 20;

export const WEB_SEARCH_MAX_DOMAIN_CHARS = 253;

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

export type WebSearchRecency = z.infer<typeof webSearchRecencySchema>;

export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;
